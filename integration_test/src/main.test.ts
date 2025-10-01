import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';
import * as Minio from 'minio';
import { init, compress } from '@bokuweb/zstd-wasm';
import JSZip from 'jszip';

// --- Test Configuration ---
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
// ### <<< 修正点 >>> ###
// テスト成果物を出力するディレクトリを定義
const TEST_OUTPUT_DIR = path.resolve(__dirname, '../test-output');

// --- Helper Functions ---
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollForDbStatus(
  pool: Pool,
  query: string,
  params: any[],
  expectedValue: any,
  timeout = 15000,
  interval = 1000,
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const { rows } = await pool.query(query, params);
    if (rows.length > 0 && rows[0].status === expectedValue) {
      console.log(`[Polling] Success! DB status reached '${expectedValue}'.`);
      return true;
    }
    await sleep(interval);
  }
  throw new Error(`Polling for DB status '${expectedValue}' timed out after ${timeout}ms.`);
}

async function pollForTaskStatus(
  taskId: string,
  expectedStatus: string,
  timeout = 60000,
  interval = 2000,
): Promise<any> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    console.log(`[Polling] Checking status for BIDS task ${taskId}...`);
    const response = await fetch(`${BASE_URL}/export-tasks/${taskId}`);
    if (response.ok) {
      const task = await response.json();
      if (task.status === expectedStatus) {
        console.log(`[Polling] Success! BIDS task status reached '${expectedStatus}'.`);
        return task;
      }
      if (task.status === 'failed') {
        throw new Error(
          `Polling failed: BIDS task entered 'failed' state with message: ${task.error_message}`,
        );
      }
    }
    await sleep(interval);
  }
  throw new Error(`Polling for BIDS task status '${expectedStatus}' timed out after ${timeout}ms.`);
}

function createMockDeviceDataBuffer(
  numPoints: number,
  triggerIndices: number[],
  startTimestampUs: bigint,
): Buffer {
  const HEADER_SIZE = 18;
  const POINT_SIZE = 53;
  const EEG_CHANNELS = 8;
  const header = Buffer.alloc(HEADER_SIZE);
  header.write('test-device-12345', 0, 'utf-8');
  const payload = Buffer.alloc(POINT_SIZE * numPoints);
  let currentTimestamp = startTimestampUs;
  for (let i = 0; i < numPoints; i++) {
    const offset = i * POINT_SIZE;
    for (let ch = 0; ch < EEG_CHANNELS; ch++) {
      payload.writeUInt16LE(2048 + ch, offset + ch * 2);
    }
    const isTrigger = triggerIndices.includes(i);
    payload.writeUInt8(isTrigger ? 1 : 0, offset + 48);
    payload.writeUInt32LE(Number(currentTimestamp & 0xffffffffn), offset + 49);
    currentTimestamp += BigInt(Math.floor(1000000 / 256));
  }
  return Buffer.concat([header, payload]);
}

// --- Test Suite ---
describe('Full End-to-End Smartphone App Simulation', () => {
  let dbPool: Pool;
  let minioClient: Minio.Client;
  let experimentId: string;

  beforeAll(async () => {
    await init();
    dbPool = new Pool({ connectionString: DATABASE_URL });
    minioClient = new Minio.Client(MINIO_CONFIG);

    // ### <<< 修正点 >>> ###
    await fs.mkdir(TEST_OUTPUT_DIR, { recursive: true });
    console.log(`[Test Setup] Test output will be saved to: ${TEST_OUTPUT_DIR}`);

    await dbPool.query('TRUNCATE TABLE experiments CASCADE');
    await dbPool.query('TRUNCATE TABLE calibration_items CASCADE');
    console.log('[Test Setup] Cleaned database tables.');

    console.log('[Test Setup] Seeding global calibration items...');
    const calibrationAssets = [
      { fileName: 'face01.png', itemType: 'target', filePath: path.join(ASSETS_DIR, 'face01.png') },
      {
        fileName: 'house01.png',
        itemType: 'nontarget',
        filePath: path.join(ASSETS_DIR, 'house01.png'),
      },
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
    console.log('[Test Setup] Initialized DB, MinIO clients, and seeded calibration items.');
  });

  afterAll(async () => {
    await dbPool.end();
    console.log('[Teardown] Cleaned up test resources.');
    process.exit(0);
  });

  test('should simulate the entire workflow from experiment creation to BIDS download', async () => {
    // Step 1: Owner creates a new experiment
    console.log('\n🧪 [Step 1] Owner creates a new experiment...');
    const createExpResponse = await fetch(`${BASE_URL}/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': OWNER_ID },
      body: JSON.stringify({
        name: 'NeuroMarketing Product Test',
        description: 'Test with Products A and B',
        presentation_order: 'sequential',
      }),
    });
    expect(createExpResponse.status).toBe(201);
    const expBody = await createExpResponse.json();
    experimentId = expBody.experiment_id;
    console.log(`✅ [Step 1] Experiment created with ID: ${experimentId}`);

    // Step 1.1: Verify experiment settings
    console.log('\n🧪 [Step 1.1] Verifying experiment settings...');
    const verifyExpResponse = await fetch(`${BASE_URL}/experiments`, {
      headers: { 'X-User-Id': OWNER_ID },
    });
    const ownedExperiments = await verifyExpResponse.json();
    const thisExperiment = ownedExperiments.find((exp: any) => exp.experiment_id === experimentId);
    expect(thisExperiment.presentation_order).toBe('sequential');
    console.log('✅ [Step 1.1] Experiment settings are correct.');

    // Step 1.5: Owner uploads stimuli for the experiment
    console.log('\n🧪 [Step 1.5] Owner uploads stimuli for the experiment...');
    const formDataStimuli = new FormData();
    formDataStimuli.append(
      'stimuli_definition_csv',
      Bun.file(path.join(ASSETS_DIR, 'stimuli_definition.csv')),
    );
    formDataStimuli.append(
      'stimulus_files',
      Bun.file(path.join(ASSETS_DIR, 'product_a.png')),
      'product_a.png',
    );
    formDataStimuli.append(
      'stimulus_files',
      Bun.file(path.join(ASSETS_DIR, 'product_b.png')),
      'product_b.png',
    );
    const registerStimuliResponse = await fetch(`${BASE_URL}/experiments/${experimentId}/stimuli`, {
      method: 'POST',
      headers: { 'X-User-Id': OWNER_ID },
      body: formDataStimuli,
    });
    expect(registerStimuliResponse.status).toBe(202);
    console.log('✅ [Step 1.5] Stimuli registration accepted.');

    // Step 1.6: Stranger fails to upload stimuli
    console.log('\n🧪 [Step 1.6] Stranger fails to upload stimuli (auth test)...');
    const unauthorizedStimuliResponse = await fetch(
      `${BASE_URL}/experiments/${experimentId}/stimuli`,
      {
        method: 'POST',
        headers: { 'X-User-Id': STRANGER_ID },
        body: formDataStimuli,
      },
    );
    expect(unauthorizedStimuliResponse.status).toBe(403);
    console.log('✅ [Step 1.6] Correctly forbidden for stranger.');

    // Step 2: A new participant joins the experiment and lists it
    console.log('\n🧪 [Step 2] Participant joins and lists experiments...');
    const joinResponse = await fetch(`${BASE_URL}/auth/experiments/${experimentId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: PARTICIPANT_ID }),
    });
    expect(joinResponse.status).toBe(201);
    const listResponse = await fetch(`${BASE_URL}/experiments`, {
      headers: { 'X-User-Id': PARTICIPANT_ID },
    });
    const experiments = await listResponse.json();
    expect(experiments).toHaveLength(1);
    expect(experiments[0].experiment_id).toBe(experimentId);
    console.log('✅ [Step 2] Participant successfully joined and listed the experiment.');

    const clockOffsetInfo = { offset_ms_avg: -150.5, rtt_ms_avg: 45.2 };
    const baseTime = Date.now() - 60000;
    const calibDuration = 20000;
    const mainTaskDuration = 20000;
    const gapBetweenSessions = 30000;
    const calibStartTime = new Date(baseTime);
    const calibEndTime = new Date(baseTime + calibDuration);
    const mainStartTime = new Date(calibEndTime.getTime() + gapBetweenSessions);
    const mainEndTime = new Date(mainStartTime.getTime() + mainTaskDuration);

    // Step 4: App simulates an "All-in-One" Calibration Session
    console.log('\n🧪 [Step 4] Simulating "All-in-One" Calibration Session...');
    const calibAssetsResponse = await fetch(`${BASE_URL}/calibrations`, {
      headers: { 'X-User-Id': PARTICIPANT_ID },
    });
    expect(calibAssetsResponse.ok).toBe(true);
    console.log('✅ [Step 4.1] App fetched calibration assets.');

    // Step 4.1.1: Download a calibration image
    console.log('\n🧪 [Step 4.1.1] App downloads a calibration image...');
    const calibImageResponse = await fetch(`${BASE_URL}/stimuli/download/face01.png`, {
      headers: { 'X-User-Id': PARTICIPANT_ID },
    });
    expect(calibImageResponse.ok).toBe(true);
    expect(calibImageResponse.headers.get('Content-Type')).toBe('image/png');
    const downloadedCalibImage = await calibImageResponse.arrayBuffer();
    const localCalibImage = await Bun.file(path.join(ASSETS_DIR, 'face01.png')).arrayBuffer();
    expect(downloadedCalibImage.byteLength).toBe(localCalibImage.byteLength);
    console.log('✅ [Step 4.1.1] Calibration image downloaded successfully.');

    const calibSessionId = `cal-session-${Date.now()}`;
    console.log('✅ [Step 4.2] App starts the calibration session...');
    const calibStartResponse = await fetch(`${BASE_URL}/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': PARTICIPANT_ID },
      body: JSON.stringify({
        session_id: calibSessionId,
        user_id: PARTICIPANT_ID,
        experiment_id: experimentId,
        start_time: calibStartTime.toISOString(),
        session_type: 'calibration',
      }),
    });
    expect(calibStartResponse.ok).toBe(true);

    const calibObjectId = `raw/${PARTICIPANT_ID}/${calibSessionId}_calib_data.zst`;
    const calibDeviceStartTimeUs =
      BigInt(Math.round(calibStartTime.getTime() - clockOffsetInfo.offset_ms_avg)) * 1000n;
    await dbPool.query(
      `INSERT INTO raw_data_objects (object_id, user_id, device_id, start_time_device, end_time_device) VALUES ($1, $2, 'calib-device', $3, $4)`,
      [
        calibObjectId,
        PARTICIPANT_ID,
        calibDeviceStartTimeUs.toString(),
        (calibDeviceStartTimeUs + BigInt(calibDuration * 1000)).toString(),
      ],
    );
    const calibMockBuffer = createMockDeviceDataBuffer(256, [10, 50, 100], calibDeviceStartTimeUs);
    await minioClient.putObject(
      MINIO_RAW_DATA_BUCKET,
      calibObjectId,
      Buffer.from(compress(calibMockBuffer)),
    );
    console.log('✅ [Step 4.3] Simulated raw data for calibration session.');

    const calibForm = new FormData();
    calibForm.append(
      'metadata',
      JSON.stringify({
        session_id: calibSessionId,
        user_id: PARTICIPANT_ID,
        experiment_id: experimentId,
        device_id: 'test-device-calib',
        start_time: calibStartTime.toISOString(),
        end_time: calibEndTime.toISOString(),
        session_type: 'calibration',
        clock_offset_info: clockOffsetInfo,
      }),
    );
    calibForm.append('events_log_csv', Bun.file(path.join(ASSETS_DIR, 'calibration_events.csv')));
    console.log('✅ [Step 4.4] App ends the calibration session...');
    const calibEndResponse = await fetch(`${BASE_URL}/sessions/end`, {
      method: 'POST',
      headers: { 'X-User-Id': PARTICIPANT_ID },
      body: calibForm,
    });
    expect(calibEndResponse.ok).toBe(true);
    console.log('✅ [Step 4.5] Calibration session ended successfully.');

    // Step 5 & 6: App simulates a "Hybrid" Main Task Session (using PsychoPy)
    console.log('\n🧪 [Step 5 & 6] Simulating "Hybrid" Main Task Session...');
    const mainSessionId = `main-session-${Date.now()}`;
    const stimuliListResponse = await fetch(`${BASE_URL}/experiments/${experimentId}/stimuli`, {
      headers: { 'X-User-Id': PARTICIPANT_ID },
    });
    expect(stimuliListResponse.ok).toBe(true);
    console.log('✅ [Step 5.1] App fetched stimuli list for PsychoPy.');

    // Step 5.1.1: Stranger fails to fetch stimuli list
    console.log('\n🧪 [Step 5.1.1] Stranger fails to fetch stimuli list (auth test)...');
    const unauthorizedListResponse = await fetch(
      `${BASE_URL}/experiments/${experimentId}/stimuli`,
      {
        headers: { 'X-User-Id': STRANGER_ID },
      },
    );
    expect(unauthorizedListResponse.status).toBe(403);
    console.log('✅ [Step 5.1.1] Correctly forbidden for stranger.');

    // Step 5.1.2: Participant downloads a task image
    console.log('\n🧪 [Step 5.1.2] App downloads a task image...');
    const taskImageResponse = await fetch(`${BASE_URL}/stimuli/download/product_a.png`, {
      headers: { 'X-User-Id': PARTICIPANT_ID },
    });
    expect(taskImageResponse.ok).toBe(true);
    expect(taskImageResponse.headers.get('Content-Type')).toBe('image/png');
    const downloadedTaskImage = await taskImageResponse.arrayBuffer();
    const localTaskImage = await Bun.file(path.join(ASSETS_DIR, 'product_a.png')).arrayBuffer();
    expect(downloadedTaskImage.byteLength).toBe(localTaskImage.byteLength);
    console.log('✅ [Step 5.1.2] Task image downloaded successfully.');

    await fetch(`${BASE_URL}/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': PARTICIPANT_ID },
      body: JSON.stringify({
        session_id: mainSessionId,
        user_id: PARTICIPANT_ID,
        experiment_id: experimentId,
        start_time: mainStartTime.toISOString(),
        session_type: 'main_external',
      }),
    });

    const mainObjectId = `raw/${PARTICIPANT_ID}/${mainSessionId}_main_data.zst`;
    const mainDeviceStartTimeUs =
      BigInt(Math.round(mainStartTime.getTime() - clockOffsetInfo.offset_ms_avg)) * 1000n;
    await dbPool.query(
      `INSERT INTO raw_data_objects (object_id, user_id, device_id, start_time_device, end_time_device) VALUES ($1, $2, 'main-device', $3, $4)`,
      [
        mainObjectId,
        PARTICIPANT_ID,
        mainDeviceStartTimeUs.toString(),
        (mainDeviceStartTimeUs + BigInt(mainTaskDuration * 1000)).toString(),
      ],
    );
    const mainMockBuffer = createMockDeviceDataBuffer(256, [20, 80], mainDeviceStartTimeUs);
    await minioClient.putObject(
      MINIO_RAW_DATA_BUCKET,
      mainObjectId,
      Buffer.from(compress(mainMockBuffer)),
    );
    console.log('✅ [Step 5.2] Simulated raw data for main task session.');

    const mainForm = new FormData();
    mainForm.append(
      'metadata',
      JSON.stringify({
        session_id: mainSessionId,
        user_id: PARTICIPANT_ID,
        experiment_id: experimentId,
        device_id: 'test-device-main',
        start_time: mainStartTime.toISOString(),
        end_time: mainEndTime.toISOString(),
        session_type: 'main_external',
        clock_offset_info: clockOffsetInfo,
      }),
    );
    mainForm.append('events_log_csv', Bun.file(path.join(ASSETS_DIR, 'main_task_events.csv')));
    const mainEndResponse = await fetch(`${BASE_URL}/sessions/end`, {
      method: 'POST',
      headers: { 'X-User-Id': PARTICIPANT_ID },
      body: mainForm,
    });
    expect(mainEndResponse.ok).toBe(true);
    console.log('✅ [Step 6] Main task session ended successfully.');

    console.log('\n🧪 [Step 6.5] Waiting for all backend processing to complete...');
    await pollForDbStatus(
      dbPool,
      'SELECT link_status as status FROM sessions WHERE session_id = $1',
      [calibSessionId],
      'completed',
    );
    await pollForDbStatus(
      dbPool,
      'SELECT event_correction_status as status FROM sessions WHERE session_id = $1',
      [calibSessionId],
      'completed',
    );
    await pollForDbStatus(
      dbPool,
      'SELECT link_status as status FROM sessions WHERE session_id = $1',
      [mainSessionId],
      'completed',
    );
    await pollForDbStatus(
      dbPool,
      'SELECT event_correction_status as status FROM sessions WHERE session_id = $1',
      [mainSessionId],
      'completed',
    );
    console.log('✅ [Step 6.5] All backend jobs are completed.');

    // Step 7: Owner requests BIDS export
    console.log('\n🧪 [Step 7] Owner requests BIDS export...');
    const startExportResponse = await fetch(`${BASE_URL}/experiments/${experimentId}/export`, {
      method: 'POST',
      headers: { 'X-User-Id': OWNER_ID },
    });
    expect(startExportResponse.status).toBe(202);
    const { task_id } = await startExportResponse.json();
    console.log(`✅ [Step 7.1] BIDS export task started with ID: ${task_id}`);

    // Step 7.1.1: Stranger fails to request BIDS export
    console.log('\n🧪 [Step 7.1.1] Stranger fails to request BIDS export (auth test)...');
    const unauthorizedExportResponse = await fetch(
      `${BASE_URL}/experiments/${experimentId}/export`,
      {
        method: 'POST',
        headers: { 'X-User-Id': STRANGER_ID },
      },
    );
    expect(unauthorizedExportResponse.status).toBe(403);
    console.log('✅ [Step 7.1.1] Correctly forbidden for stranger.');

    const completedTask = await pollForTaskStatus(task_id, 'completed');
    expect(completedTask.status).toBe('completed');
    console.log('✅ [Step 7.2] BIDS export task completed.');

    // Step 8: Owner downloads, saves, and verifies the BIDS file
    console.log('\n🧪 [Step 8] Owner downloads, saves, and verifies BIDS file...');
    const downloadResponse = await fetch(`${BASE_URL}/export-tasks/${task_id}/download`, {
      headers: { 'X-User-Id': OWNER_ID },
    });
    expect(downloadResponse.ok).toBe(true);

    const zipData = await downloadResponse.arrayBuffer();

    // Save the downloaded zip file
    const zipPath = path.join(TEST_OUTPUT_DIR, `bids_export_${experimentId}.zip`);
    await Bun.write(zipPath, zipData);
    console.log(`✅ [Step 8.1] BIDS archive saved to: ${zipPath}`);

    // Load with jszip for verification and extraction
    const zip = await JSZip.loadAsync(zipData);

    const subjectId = PARTICIPANT_ID.replace(/-/g, '');
    const calibPathInZip = `bids_dataset/sub-${subjectId}/ses-1/eeg/sub-${subjectId}_ses-1_task-calibration_eeg.json`;
    const mainPathInZip = `bids_dataset/sub-${subjectId}/ses-2/eeg/sub-${subjectId}_ses-2_task-mainexternal_eeg.json`;

    // Verify key files exist in the zip
    expect(zip.file(calibPathInZip)).not.toBeNull();
    expect(zip.file(mainPathInZip)).not.toBeNull();
    console.log('✅ [Step 8.2] BIDS archive content verified successfully.');

    // Extract all files from the zip
    const extractionPath = path.join(TEST_OUTPUT_DIR, `bids_export_${experimentId}`);
    await fs.mkdir(extractionPath, { recursive: true });

    for (const filename in zip.files) {
      const file = zip.files[filename];
      const destPath = path.join(extractionPath, filename);

      if (file.dir) {
        await fs.mkdir(destPath, { recursive: true });
      } else {
        const content = await file.async('nodebuffer');
        await fs.writeFile(destPath, content);
      }
    }
    console.log(`✅ [Step 8.3] BIDS archive extracted to: ${extractionPath}`);
  }, 90000);
});
