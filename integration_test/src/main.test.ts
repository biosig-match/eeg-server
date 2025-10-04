import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';
import * as Minio from 'minio';
import { init as initZstd, compress } from '@bokuweb/zstd-wasm';
import JSZip from 'jszip';

const BASE_URL = 'http://localhost:8080/api/v1';
const DATABASE_URL = 'postgres://admin:password@localhost:5432/eeg_data';
const MINIO_CONFIG = {
  endPoint: 'localhost',
  port: 9000,
  useSSL: false,
  accessKey: 'minioadmin',
  secretKey: 'minioadmin',
};
const MINIO_RAW_DATA_BUCKET = 'raw-data';
const MINIO_MEDIA_BUCKET = 'media';
const BIDS_BUCKET = 'bids-exports';

const OWNER_ID = `test-owner-${Date.now()}`;
const PARTICIPANT_ID = `test-participant-${Date.now()}`;
const STRANGER_ID = `test-stranger-${Date.now()}`;

const ASSETS_DIR = path.resolve(__dirname, '../assets');
const TEST_OUTPUT_DIR = path.resolve(__dirname, '../test-output');

const HEADER_SIZE = 18;
const POINT_SIZE = 53;
const EEG_CHANNELS = 8;
const SAMPLE_RATE = 256; // Hz
const MICROSECONDS_PER_SECOND = 1_000_000n;

interface WorkflowContext {
  ownerId: string;
  participantId: string;
  strangerId: string;
  experimentId: string;
  stimuliUploadStatus: number;
  stimuliObjectIds: string[];
  participantExperimentsCount: number;
  participantsList: Array<{ user_id: string; role: string }>;
  stimuliListForParticipant: Array<{ file_name: string }>;
  calibSessionId: string;
  mainSessionId: string;
  collectorDataStatuses: number[];
  collectorMediaStatus: number;
  rawDataObjectIds: string[];
  normalizedRawDataObjects: Array<{ object_id: string; start_time: string | null; end_time: string | null }>;
  sessionObjectLinkCounts: Record<string, number>;
  sessionEventsCorrectedCount: Record<string, number>;
  imageObjectId?: string;
  bidsTaskId: string;
  bidsResultFilePath: string;
  bidsZipPath: string;
  bidsExtractionDir: string;
  bidsArchiveEntries: string[];
  bidsFilesOnDisk: string[];
  bidsDownloadedSize: number;
  realtimeAnalysis: {
    psd_image: string;
    coherence_image: string;
    timestamp: string;
  };
  erpAnalysis: {
    summary: string;
    recommendations: Array<Record<string, unknown>>;
  };
  unauthorizedStimuliUploadStatus: number;
  unauthorizedStimuliListStatus: number;
  unauthorizedExportStatus: number;
  sessionStatuses: Record<string, { link: string; correction: string }>;
}

let dbPool: Pool;
let minioClient: Minio.Client;
let workflow: WorkflowContext;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollForDbStatus(
  query: string,
  params: any[],
  expectedValue: any,
  timeout = 20000,
  interval = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { rows } = await dbPool.query(query, params);
    if (rows.length > 0 && rows[0].status === expectedValue) {
      return;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for DB status '${expectedValue}' with query ${query}`);
}

async function pollForTaskStatus(
  taskId: string,
  expectedStatus: string,
  timeout = 120000,
  interval = 2000,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const response = await fetch(`${BASE_URL}/export-tasks/${taskId}`);
    if (response.ok) {
      const task = await response.json();
      if (task.status === expectedStatus) {
        return task;
      }
      if (task.status === 'failed') {
        throw new Error(`Export task ${taskId} failed: ${task.error_message ?? 'unknown error'}`);
      }
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for export task ${taskId} to reach status ${expectedStatus}`);
}

function createMockDeviceDataBuffer(
  deviceId: string,
  numPoints: number,
  triggerIndices: number[],
  startTimestampUs: bigint,
): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write(deviceId, 0, 'utf-8');
  const payload = Buffer.alloc(POINT_SIZE * numPoints);
  let currentTimestamp = startTimestampUs;
  const stepUs = BigInt(Math.floor(Number(MICROSECONDS_PER_SECOND) / SAMPLE_RATE));

  for (let i = 0; i < numPoints; i++) {
    const offset = i * POINT_SIZE;
    for (let ch = 0; ch < EEG_CHANNELS; ch++) {
      payload.writeUInt16LE(2048 + ch, offset + ch * 2);
    }
    const isTrigger = triggerIndices.includes(i);
    payload.writeUInt8(isTrigger ? 1 : 0, offset + 48);
    payload.writeUInt32LE(Number(currentTimestamp & 0xffffffffn), offset + 49);
    currentTimestamp += stepUs;
  }

  return Buffer.concat([header, payload]);
}

async function resetDatabase() {
  await dbPool.query(`
    TRUNCATE TABLE
      erp_analysis_results,
      session_object_links,
      session_events,
      images,
      audio_clips,
      raw_data_objects,
      sessions,
      experiment_participants,
      experiment_stimuli,
      export_tasks,
      experiments
    CASCADE
  `);
  await dbPool.query('TRUNCATE TABLE calibration_items RESTART IDENTITY CASCADE');
}

async function seedCalibrationAssets() {
  const calibrationAssets = [
    { fileName: 'face01.png', itemType: 'target', filePath: path.join(ASSETS_DIR, 'face01.png') },
    { fileName: 'house01.png', itemType: 'nontarget', filePath: path.join(ASSETS_DIR, 'house01.png') },
  ];

  for (const asset of calibrationAssets) {
    const objectId = `stimuli/calibration/${asset.fileName}`;
    await minioClient.fPutObject(MINIO_MEDIA_BUCKET, objectId, asset.filePath, {
      'Content-Type': 'image/png',
    });
    await dbPool.query(
      `INSERT INTO calibration_items (file_name, item_type, object_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (file_name) DO UPDATE SET
         item_type = EXCLUDED.item_type,
         object_id = EXCLUDED.object_id`,
      [asset.fileName, asset.itemType, objectId],
    );
  }
}

async function sendCollectorData(userId: string, buffer: Buffer): Promise<number> {
  const compressedPayload = Buffer.from(compress(buffer));
  const payloadBase64 = compressedPayload.toString('base64');
  const response = await fetch(`${BASE_URL}/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, payload_base64: payloadBase64 }),
  });
  return response.status;
}

async function sendCollectorMedia(
  userId: string,
  sessionId: string,
  localFilePath: string,
  timestamp: Date,
  mimetype: string,
  originalFilename: string,
): Promise<number> {
  const form = new FormData();
  form.append('file', Bun.file(localFilePath), originalFilename);
  form.append('user_id', userId);
  form.append('session_id', sessionId);
  form.append('mimetype', mimetype);
  form.append('original_filename', originalFilename);
  form.append('timestamp_utc', timestamp.toISOString());

  const response = await fetch(`${BASE_URL}/media`, {
    method: 'POST',
    body: form,
  });
  return response.status;
}

async function waitForStimuli(experimentId: string, expectedCount: number, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await dbPool.query(
      'SELECT file_name, object_id FROM experiment_stimuli WHERE experiment_id = $1',
      [experimentId],
    );
    if ((result.rowCount ?? 0) >= expectedCount) {
      return result.rows as Array<{ file_name: string; object_id: string }>;
    }
    await sleep(1000);
  }
  throw new Error(`Stimulus processor did not persist ${expectedCount} items for experiment ${experimentId}`);
}

async function waitForRawDataObjects(userId: string, expectedCount: number, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await dbPool.query(
      'SELECT object_id, start_time, end_time FROM raw_data_objects WHERE user_id = $1 ORDER BY start_time_device ASC',
      [userId],
    );
    if ((result.rowCount ?? 0) >= expectedCount) {
      return result.rows as Array<{ object_id: string; start_time: string | null; end_time: string | null }>;
    }
    await sleep(1000);
  }
  throw new Error(`Processor did not persist ${expectedCount} raw data objects for user ${userId}`);
}

async function waitForImages(sessionId: string, expectedCount: number, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await dbPool.query(
      'SELECT object_id, experiment_id FROM images WHERE session_id = $1',
      [sessionId],
    );
    if ((result.rowCount ?? 0) >= expectedCount) {
      return result.rows as Array<{ object_id: string; experiment_id: string | null }>;
    }
    await sleep(1000);
  }
  throw new Error(`Media processor did not persist expected images for session ${sessionId}`);
}

async function waitForCorrectedEvents(sessionId: string, expectedCount: number, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await dbPool.query(
      'SELECT COUNT(*)::int AS count FROM session_events WHERE session_id = $1 AND onset_corrected_us IS NOT NULL',
      [sessionId],
    );
    const count = result.rows[0]?.count ?? 0;
    if (count >= expectedCount) {
      return count;
    }
    await sleep(1000);
  }
  throw new Error(`Event Corrector did not update ${expectedCount} events for session ${sessionId}`);
}

async function waitForSessionLinks(sessionId: string, expectedMinimum: number, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await dbPool.query(
      'SELECT COUNT(*)::int AS count FROM session_object_links WHERE session_id = $1',
      [sessionId],
    );
    const count = result.rows[0]?.count ?? 0;
    if (count >= expectedMinimum) {
      return count;
    }
    await sleep(1000);
  }
  throw new Error(`Data Linker did not link ${expectedMinimum} objects for session ${sessionId}`);
}

async function waitForRealtimeAnalysis(userId: string, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const response = await fetch(`${BASE_URL}/users/${userId}/analysis`);
    if (response.status === 200) {
      return (await response.json()) as {
        psd_image: string;
        coherence_image: string;
        timestamp: string;
      };
    }
    await sleep(1500);
  }
  throw new Error(`Realtime analyzer did not produce results for user ${userId}`);
}

async function listFilesRecursively(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursively(fullPath);
      for (const nestedPath of nested) {
        files.push(nestedPath);
      }
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function runFullWorkflow(): Promise<WorkflowContext> {
  const ctx: WorkflowContext = {
    ownerId: OWNER_ID,
    participantId: PARTICIPANT_ID,
    strangerId: STRANGER_ID,
    experimentId: '',
    stimuliUploadStatus: 0,
    stimuliObjectIds: [],
    participantExperimentsCount: 0,
    participantsList: [],
    stimuliListForParticipant: [],
    calibSessionId: '',
    mainSessionId: '',
    collectorDataStatuses: [],
    collectorMediaStatus: 0,
    rawDataObjectIds: [],
    normalizedRawDataObjects: [],
    sessionObjectLinkCounts: {},
    sessionEventsCorrectedCount: {},
    bidsTaskId: '',
    bidsResultFilePath: '',
    bidsZipPath: '',
    bidsExtractionDir: '',
    bidsArchiveEntries: [],
    bidsFilesOnDisk: [],
    bidsDownloadedSize: 0,
    realtimeAnalysis: { psd_image: '', coherence_image: '', timestamp: '' },
    erpAnalysis: { summary: '', recommendations: [] },
    unauthorizedStimuliUploadStatus: 0,
    unauthorizedStimuliListStatus: 0,
    unauthorizedExportStatus: 0,
    sessionStatuses: {},
  };

  // 1. Create experiment
  const createExpResponse = await fetch(`${BASE_URL}/experiments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': OWNER_ID },
    body: JSON.stringify({
      name: 'NeuroMarketing Product Test',
      description: 'Integration coverage scenario',
      presentation_order: 'sequential',
    }),
  });
  if (createExpResponse.status !== 201) {
    throw new Error(`Failed to create experiment. Status: ${createExpResponse.status}`);
  }
  const experiment = await createExpResponse.json();
  ctx.experimentId = experiment.experiment_id;

  // 2. Upload stimuli (owner)
  const buildStimuliForm = () => {
    const form = new FormData();
    form.append('stimuli_definition_csv', Bun.file(path.join(ASSETS_DIR, 'stimuli_definition.csv')));
    form.append('stimulus_files', Bun.file(path.join(ASSETS_DIR, 'product_a.png')), 'product_a.png');
    form.append('stimulus_files', Bun.file(path.join(ASSETS_DIR, 'product_b.png')), 'product_b.png');
    return form;
  };

  const uploadStimuliResponse = await fetch(`${BASE_URL}/experiments/${ctx.experimentId}/stimuli`, {
    method: 'POST',
    headers: { 'X-User-Id': OWNER_ID },
    body: buildStimuliForm(),
  });
  ctx.stimuliUploadStatus = uploadStimuliResponse.status;
  if (uploadStimuliResponse.status !== 202) {
    throw new Error(`Stimulus upload failed. Status: ${uploadStimuliResponse.status}`);
  }

  const unauthorizedStimuliResponse = await fetch(`${BASE_URL}/experiments/${ctx.experimentId}/stimuli`, {
    method: 'POST',
    headers: { 'X-User-Id': STRANGER_ID },
    body: buildStimuliForm(),
  });
  ctx.unauthorizedStimuliUploadStatus = unauthorizedStimuliResponse.status;

  const stimuliRows = await waitForStimuli(ctx.experimentId, 2);
  ctx.stimuliObjectIds = stimuliRows.map((row) => row.object_id);

  // 3. Participant joins experiment
  const joinResponse = await fetch(`${BASE_URL}/auth/experiments/${ctx.experimentId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: PARTICIPANT_ID }),
  });
  if (joinResponse.status !== 201) {
    throw new Error(`Participant failed to join experiment. Status: ${joinResponse.status}`);
  }

  const experimentsResponse = await fetch(`${BASE_URL}/experiments`, {
    headers: { 'X-User-Id': PARTICIPANT_ID },
  });
  if (!experimentsResponse.ok) {
    throw new Error(`Failed to list experiments for participant. Status: ${experimentsResponse.status}`);
  }
  const experimentsList = (await experimentsResponse.json()) as Array<{ experiment_id: string }>;
  ctx.participantExperimentsCount = experimentsList.length;

  ctx.stimuliListForParticipant = await (async () => {
    const resp = await fetch(`${BASE_URL}/experiments/${ctx.experimentId}/stimuli`, {
      headers: { 'X-User-Id': PARTICIPANT_ID },
    });
    if (!resp.ok) {
      throw new Error(`Participant failed to fetch stimuli list. Status: ${resp.status}`);
    }
    return (await resp.json()) as Array<{ file_name: string }>;
  })();

  const unauthorizedStimuliListResp = await fetch(`${BASE_URL}/experiments/${ctx.experimentId}/stimuli`, {
    headers: { 'X-User-Id': STRANGER_ID },
  });
  ctx.unauthorizedStimuliListStatus = unauthorizedStimuliListResp.status;

  // 4. Sessions setup
  const clockOffsetInfo = { offset_ms_avg: -150.5, rtt_ms_avg: 45.2 };
  const now = Date.now();
  const calibDurationMs = 20000;
  const mainDurationMs = 20000;
  const gapBetweenSessions = 15000;

  const calibStartTime = new Date(now);
  const calibEndTime = new Date(now + calibDurationMs);
  const mainStartTime = new Date(calibEndTime.getTime() + gapBetweenSessions);
  const mainEndTime = new Date(mainStartTime.getTime() + mainDurationMs);

  ctx.calibSessionId = `cal-session-${Date.now()}`;
  const startCalibResponse = await fetch(`${BASE_URL}/sessions/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': PARTICIPANT_ID },
    body: JSON.stringify({
      session_id: ctx.calibSessionId,
      user_id: PARTICIPANT_ID,
      experiment_id: ctx.experimentId,
      start_time: calibStartTime.toISOString(),
      session_type: 'calibration',
    }),
  });
  if (startCalibResponse.status !== 201) {
    throw new Error(`Failed to start calibration session. Status: ${startCalibResponse.status}`);
  }

  ctx.mainSessionId = `main-session-${Date.now()}`;
  const startMainResponse = await fetch(`${BASE_URL}/sessions/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': PARTICIPANT_ID },
    body: JSON.stringify({
      session_id: ctx.mainSessionId,
      user_id: PARTICIPANT_ID,
      experiment_id: ctx.experimentId,
      start_time: mainStartTime.toISOString(),
      session_type: 'main_external',
    }),
  });
  if (startMainResponse.status !== 201) {
    throw new Error(`Failed to start main session. Status: ${startMainResponse.status}`);
  }

  // 5. Send EEG data via collector (3 blocks per session)
  const blocksPerSession = 3;
  const pointsPerBlock = 256;
  const blockDurationUs = MICROSECONDS_PER_SECOND; // 1 second worth at 256 Hz
  const calibBaseUs = BigInt(Math.round(calibStartTime.getTime() - clockOffsetInfo.offset_ms_avg)) * 1000n;
  const mainBaseUs = BigInt(Math.round(mainStartTime.getTime() - clockOffsetInfo.offset_ms_avg)) * 1000n;

  for (let i = 0; i < blocksPerSession; i++) {
    const blockStart = calibBaseUs + blockDurationUs * BigInt(i);
    const triggers = i === 0 ? [10, 50] : i === 1 ? [100] : [];
    const buffer = createMockDeviceDataBuffer('calib-device', pointsPerBlock, triggers, blockStart);
    ctx.collectorDataStatuses.push(await sendCollectorData(PARTICIPANT_ID, buffer));
  }

  for (let i = 0; i < blocksPerSession; i++) {
    const blockStart = mainBaseUs + blockDurationUs * BigInt(i);
    const triggers = i === 0 ? [20] : i === 1 ? [80] : [];
    const buffer = createMockDeviceDataBuffer('main-device', pointsPerBlock, triggers, blockStart);
    ctx.collectorDataStatuses.push(await sendCollectorData(PARTICIPANT_ID, buffer));
  }

  ctx.rawDataObjectIds = (await waitForRawDataObjects(PARTICIPANT_ID, ctx.collectorDataStatuses.length)).map(
    (row) => row.object_id,
  );

  // 6. Upload media via collector (photo during main session)
  const mediaTimestamp = new Date(mainStartTime.getTime() + 5000);
  ctx.collectorMediaStatus = await sendCollectorMedia(
    PARTICIPANT_ID,
    ctx.mainSessionId,
    path.join(ASSETS_DIR, 'product_a.png'),
    mediaTimestamp,
    'image/png',
    'session_photo.png',
  );

  // 7. End sessions with metadata & events
  const calibForm = new FormData();
  calibForm.append('metadata', JSON.stringify({
    session_id: ctx.calibSessionId,
    user_id: PARTICIPANT_ID,
    experiment_id: ctx.experimentId,
    device_id: 'calib-device',
    start_time: calibStartTime.toISOString(),
    end_time: calibEndTime.toISOString(),
    session_type: 'calibration',
    clock_offset_info: clockOffsetInfo,
  }));
  calibForm.append('events_log_csv', Bun.file(path.join(ASSETS_DIR, 'calibration_events.csv')));
  const endCalibResp = await fetch(`${BASE_URL}/sessions/end`, {
    method: 'POST',
    headers: { 'X-User-Id': PARTICIPANT_ID },
    body: calibForm,
  });
  if (!endCalibResp.ok) {
    throw new Error(`Failed to end calibration session. Status: ${endCalibResp.status}`);
  }

  const mainForm = new FormData();
  mainForm.append('metadata', JSON.stringify({
    session_id: ctx.mainSessionId,
    user_id: PARTICIPANT_ID,
    experiment_id: ctx.experimentId,
    device_id: 'main-device',
    start_time: mainStartTime.toISOString(),
    end_time: mainEndTime.toISOString(),
    session_type: 'main_external',
    clock_offset_info: clockOffsetInfo,
  }));
  mainForm.append('events_log_csv', Bun.file(path.join(ASSETS_DIR, 'main_task_events.csv')));
  const endMainResp = await fetch(`${BASE_URL}/sessions/end`, {
    method: 'POST',
    headers: { 'X-User-Id': PARTICIPANT_ID },
    body: mainForm,
  });
  if (!endMainResp.ok) {
    throw new Error(`Failed to end main session. Status: ${endMainResp.status}`);
  }

  // 8. Wait for DataLinker & EventCorrector results
  await pollForDbStatus(
    'SELECT link_status AS status FROM sessions WHERE session_id = $1',
    [ctx.calibSessionId],
    'completed',
  );
  await pollForDbStatus(
    'SELECT event_correction_status AS status FROM sessions WHERE session_id = $1',
    [ctx.calibSessionId],
    'completed',
  );
  await pollForDbStatus(
    'SELECT link_status AS status FROM sessions WHERE session_id = $1',
    [ctx.mainSessionId],
    'completed',
  );
  await pollForDbStatus(
    'SELECT event_correction_status AS status FROM sessions WHERE session_id = $1',
    [ctx.mainSessionId],
    'completed',
  );

  ctx.sessionStatuses[ctx.calibSessionId] = { link: 'completed', correction: 'completed' };
  ctx.sessionStatuses[ctx.mainSessionId] = { link: 'completed', correction: 'completed' };

  const normalizedRows = await dbPool.query(
    'SELECT object_id, start_time, end_time FROM raw_data_objects WHERE user_id = $1 ORDER BY start_time ASC',
    [PARTICIPANT_ID],
  );
  ctx.normalizedRawDataObjects = normalizedRows.rows as Array<{
    object_id: string;
    start_time: string | null;
    end_time: string | null;
  }>;

  ctx.sessionObjectLinkCounts[ctx.calibSessionId] = await waitForSessionLinks(ctx.calibSessionId, 1);
  ctx.sessionObjectLinkCounts[ctx.mainSessionId] = await waitForSessionLinks(ctx.mainSessionId, 1);

  ctx.sessionEventsCorrectedCount[ctx.calibSessionId] = await waitForCorrectedEvents(ctx.calibSessionId, 3);
  ctx.sessionEventsCorrectedCount[ctx.mainSessionId] = await waitForCorrectedEvents(ctx.mainSessionId, 2);

  const imageRows = await waitForImages(ctx.mainSessionId, 1);
  ctx.imageObjectId = imageRows[0].object_id;

  // Ensure participant listing (owner view)
  const participantsResp = await fetch(`${BASE_URL}/auth/experiments/${ctx.experimentId}/participants`, {
    headers: { 'X-User-Id': OWNER_ID },
  });
  if (!participantsResp.ok) {
    throw new Error(`Owner failed to list participants. Status: ${participantsResp.status}`);
  }
  ctx.participantsList = (await participantsResp.json()) as Array<{ user_id: string; role: string }>;

  // 9. Trigger BIDS export
  const exportResp = await fetch(`${BASE_URL}/experiments/${ctx.experimentId}/export`, {
    method: 'POST',
    headers: { 'X-User-Id': OWNER_ID },
  });
  if (exportResp.status !== 202) {
    throw new Error(`Failed to start BIDS export. Status: ${exportResp.status}`);
  }
  const exportPayload = await exportResp.json();
  ctx.bidsTaskId = exportPayload.task_id as string;

  const unauthorizedExportResp = await fetch(`${BASE_URL}/experiments/${ctx.experimentId}/export`, {
    method: 'POST',
    headers: { 'X-User-Id': STRANGER_ID },
  });
  ctx.unauthorizedExportStatus = unauthorizedExportResp.status;

  const completedTask = await pollForTaskStatus(ctx.bidsTaskId, 'completed');
  ctx.bidsResultFilePath = completedTask.result_file_path as string;

  const downloadResp = await fetch(`${BASE_URL}/export-tasks/${ctx.bidsTaskId}/download`, {
    headers: { 'X-User-Id': OWNER_ID },
  });
  if (!downloadResp.ok) {
    throw new Error(`Failed to download BIDS export. Status: ${downloadResp.status}`);
  }

  const zipBuffer = Buffer.from(await downloadResp.arrayBuffer());
  ctx.bidsDownloadedSize = zipBuffer.byteLength;
  ctx.bidsZipPath = path.join(TEST_OUTPUT_DIR, `bids_export_${ctx.experimentId}.zip`);
  await Bun.write(ctx.bidsZipPath, zipBuffer);

  const zip = await JSZip.loadAsync(zipBuffer);
  ctx.bidsArchiveEntries = Object.keys(zip.files);

  ctx.bidsExtractionDir = path.join(TEST_OUTPUT_DIR, `bids_export_${ctx.experimentId}`);
  await fs.mkdir(ctx.bidsExtractionDir, { recursive: true });
  const extractPromises: Promise<void>[] = [];
  zip.forEach((relativePath, file) => {
    const destPath = path.join(ctx.bidsExtractionDir, relativePath);
    if (file.dir) {
      extractPromises.push(fs.mkdir(destPath, { recursive: true }));
    } else {
      extractPromises.push(
        (async () => {
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          const content = await file.async('nodebuffer');
          await fs.writeFile(destPath, content);
        })(),
      );
    }
  });
  await Promise.all(extractPromises);
  ctx.bidsFilesOnDisk = await listFilesRecursively(ctx.bidsExtractionDir);

  // 10. Realtime analyzer & ERP analysis
  ctx.realtimeAnalysis = await waitForRealtimeAnalysis(PARTICIPANT_ID);

  const erpResp = await fetch(`${BASE_URL}/neuro-marketing/experiments/${ctx.experimentId}/analyze`, {
    method: 'POST',
    headers: { 'X-User-Id': OWNER_ID },
  });
  if (!erpResp.ok) {
    throw new Error(`ERP analysis failed. Status: ${erpResp.status}`);
  }
  ctx.erpAnalysis = (await erpResp.json()) as WorkflowContext['erpAnalysis'];

  return ctx;
}

beforeAll(async () => {
  await initZstd();
  dbPool = new Pool({ connectionString: DATABASE_URL });
  minioClient = new Minio.Client(MINIO_CONFIG);
  await fs.mkdir(TEST_OUTPUT_DIR, { recursive: true });
  await resetDatabase();
  await seedCalibrationAssets();
  workflow = await runFullWorkflow();
});

afterAll(async () => {
  await dbPool.end();
});

function expectBase64(value: string) {
  expect(typeof value).toBe('string');
  expect(value.length).toBeGreaterThan(0);
  expect(value).toMatch(/^[A-Za-z0-9+/]+=*$/);
}

const subjectIdFromParticipant = PARTICIPANT_ID.replace(/-/g, '');
const calibJsonPath = `bids_dataset/sub-${subjectIdFromParticipant}/ses-1/eeg/sub-${subjectIdFromParticipant}_ses-1_task-calibration_eeg.json`;
const mainJsonPath = `bids_dataset/sub-${subjectIdFromParticipant}/ses-2/eeg/sub-${subjectIdFromParticipant}_ses-2_task-mainexternal_eeg.json`;

describe('EEG platform end-to-end integration', () => {
  test('stimulus asset processor registers experiment stimuli', () => {
    expect(workflow.stimuliUploadStatus).toBe(202);
    expect(workflow.stimuliObjectIds).toHaveLength(2);
    expect(workflow.stimuliObjectIds.every((id) => id.startsWith('stimuli/'))).toBe(true);
  });

  test('auth manager handles participant joins and listings', () => {
    expect(workflow.participantExperimentsCount).toBeGreaterThanOrEqual(1);
    const joined = workflow.participantsList.find((p) => p.user_id === PARTICIPANT_ID);
    expect(joined).toBeDefined();
    expect(joined?.role).toBe('participant');
  });

  test('session manager enforces authorization boundaries', () => {
    expect(workflow.unauthorizedStimuliUploadStatus).toBe(403);
    expect(workflow.unauthorizedStimuliListStatus).toBe(403);
    expect(workflow.unauthorizedExportStatus).toBe(403);
  });

  test('collector accepts raw data and media payloads', () => {
    expect(workflow.collectorDataStatuses).toHaveLength(6);
    for (const status of workflow.collectorDataStatuses) {
      expect(status).toBe(202);
    }
    expect(workflow.collectorMediaStatus).toBe(202);
  });

  test('processor stores raw data objects and DataLinker normalizes timestamps', () => {
    expect(workflow.rawDataObjectIds.length).toBe(6);
    expect(workflow.normalizedRawDataObjects.length).toBeGreaterThanOrEqual(6);
    expect(workflow.normalizedRawDataObjects.every((row) => row.start_time !== null && row.end_time !== null)).toBe(true);
  });

  test('media processor persists images and DataLinker links them to experiments', () => {
    expect(workflow.imageObjectId).toBeDefined();
    expect(workflow.imageObjectId?.startsWith('media/')).toBe(true);
  });

  test('data linker and event corrector complete successfully', () => {
    expect(workflow.sessionStatuses[workflow.calibSessionId]).toEqual({ link: 'completed', correction: 'completed' });
    expect(workflow.sessionStatuses[workflow.mainSessionId]).toEqual({ link: 'completed', correction: 'completed' });
    expect(workflow.sessionObjectLinkCounts[workflow.calibSessionId]).toBeGreaterThanOrEqual(1);
    expect(workflow.sessionObjectLinkCounts[workflow.mainSessionId]).toBeGreaterThanOrEqual(1);
    expect(workflow.sessionEventsCorrectedCount[workflow.calibSessionId]).toBe(3);
    expect(workflow.sessionEventsCorrectedCount[workflow.mainSessionId]).toBe(2);
  });

  test('participant can retrieve stimuli and assets count matches expectation', () => {
    expect(workflow.stimuliListForParticipant).toHaveLength(2);
    const fileNames = workflow.stimuliListForParticipant.map((item) => item.file_name).sort();
    expect(fileNames).toEqual(['product_a.png', 'product_b.png']);
  });

  test('bids exporter produces downloadable archive with expected contents', async () => {
    expect(workflow.bidsTaskId).not.toBe('');
    expect(workflow.bidsResultFilePath).not.toBe('');
    if (workflow.bidsResultFilePath.includes(BIDS_BUCKET)) {
      expect(workflow.bidsResultFilePath).toContain(BIDS_BUCKET);
    } else {
      expect(workflow.bidsResultFilePath.endsWith('.zip')).toBe(true);
    }
    expect(workflow.bidsDownloadedSize).toBeGreaterThan(0);
    expect(workflow.bidsArchiveEntries).toContain(calibJsonPath);
    expect(workflow.bidsArchiveEntries).toContain(mainJsonPath);

    const stats = await fs.stat(workflow.bidsZipPath);
    expect(stats.size).toBe(workflow.bidsDownloadedSize);

    const filesOnDisk = workflow.bidsFilesOnDisk.map((f) => f.replace(`${workflow.bidsExtractionDir}${path.sep}`, ''));
    expect(filesOnDisk).toEqual(expect.arrayContaining([calibJsonPath, mainJsonPath]));
  });

  test('realtime analyzer returns PSD and coherence imagery', () => {
    expectBase64(workflow.realtimeAnalysis.psd_image);
    expectBase64(workflow.realtimeAnalysis.coherence_image);
    expect(new Date(workflow.realtimeAnalysis.timestamp).toString()).not.toBe('Invalid Date');
  });

  test('ERP neuro-marketing service returns summary and recommendations payload', () => {
    expect(typeof workflow.erpAnalysis.summary).toBe('string');
    expect(workflow.erpAnalysis.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(workflow.erpAnalysis.recommendations)).toBe(true);
  });
});
