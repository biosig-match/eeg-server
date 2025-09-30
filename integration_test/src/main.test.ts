import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';
import * as Minio from 'minio';
import { init, compress } from '@bokuweb/zstd-wasm';

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
const BIDS_BUCKET = 'bids-exports'; // As defined in bids_exporter

const OWNER_ID = `test-owner-${Date.now()}`;
const PARTICIPANT_ID = `test-participant-${Date.now()}`;
const STRANGER_ID = `test-stranger-${Date.now()}`;
const EXPERIMENT_NAME = `Test Experiment ${Date.now()}`;
const PASSWORD_EXPERIMENT_NAME = `Password Protected Experiment ${Date.now()}`;
const EXPERIMENT_PASSWORD = 'strongpassword123';

const ASSETS_DIR = path.resolve(__dirname, '../assets');

// --- Helper Functions ---
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollForStimuli(
  experimentId: string,
  expectedCount: number,
  timeout = 15000,
  interval = 1000,
): Promise<any[]> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    console.log(`[Polling] Checking for stimuli for experiment ${experimentId}...`);
    const response = await fetch(`${BASE_URL}/experiments/${experimentId}/stimuli`, {
      headers: { 'X-User-Id': OWNER_ID },
    });
    if (response.ok) {
      const stimuli = await response.json();
      if (stimuli.length === expectedCount) {
        console.log(`[Polling] Success! Found ${stimuli.length} stimuli.`);
        return stimuli;
      }
    }
    await sleep(interval);
  }
  throw new Error(`Polling for stimuli timed out after ${timeout}ms.`);
}

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
    console.log(`[Polling] Checking DB for status '${expectedValue}'...`);
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
  timeout = 60000, // BIDS export can be slow, use a long timeout
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

async function createDummyImageFiles(dir: string, fileNames: string[]) {
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const imageBuffer = Buffer.from(pngBase64, 'base64');
  await fs.mkdir(dir, { recursive: true });
  for (const fileName of fileNames) {
    await fs.writeFile(path.join(dir, fileName), imageBuffer);
  }
  console.log(`[Test Setup] Created dummy files: ${fileNames.join(', ')}`);
}

function createMockDeviceDataBuffer(
  numPoints: number,
  triggerIndices: number[],
  startTimestampUs: bigint,
): Buffer {
  const HEADER_SIZE = 18;
  const POINT_SIZE = 53; // Corresponds to the SensorData struct size
  const EEG_CHANNELS = 8;

  const header = Buffer.alloc(HEADER_SIZE);
  header.write('test-device-12345', 0, 'utf-8');

  const payload = Buffer.alloc(POINT_SIZE * numPoints);

  let currentTimestamp = startTimestampUs;

  for (let i = 0; i < numPoints; i++) {
    const offset = i * POINT_SIZE;

    // EEG (8 channels * 2 bytes/channel = 16 bytes)
    for (let ch = 0; ch < EEG_CHANNELS; ch++) {
      payload.writeUInt16LE(2048 + ch, offset + ch * 2);
    }

    // Other sensor data...

    const isTrigger = triggerIndices.includes(i);
    // Trigger (1 byte) is at offset 48
    payload.writeUInt8(isTrigger ? 1 : 0, offset + 48);

    // Timestamp (4 bytes) is at offset 49
    // BigIntを32ビット符号なし整数に変換して書き込む
    payload.writeUInt32LE(Number(currentTimestamp & 0xffffffffn), offset + 49);

    currentTimestamp += BigInt(Math.floor(1000000 / 256)); // Increment by sample duration in microseconds
  }
  return Buffer.concat([header, payload]);
}

// --- Test Suite ---
describe('E2E Test for Core Service Integration', () => {
  let dbPool: Pool;
  let minioClient: Minio.Client;
  const stimulusFileNames = ['test_stimulus_1.png', 'test_stimulus_2.png'];
  let experimentId: string;
  let passwordExperimentId: string;

  beforeAll(async () => {
    await init();
    console.log('[Test Setup] ZSTD WASM Initialized.');
    dbPool = new Pool({ connectionString: DATABASE_URL });
    await dbPool.query('SELECT 1');
    console.log('[Test Setup] Connected to PostgreSQL.');
    minioClient = new Minio.Client(MINIO_CONFIG);
    console.log('[Test Setup] MinIO Client Initialized.');
    await createDummyImageFiles(ASSETS_DIR, stimulusFileNames);
    const createExpResponse = await fetch(`${BASE_URL}/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': OWNER_ID },
      body: JSON.stringify({ name: EXPERIMENT_NAME }),
    });
    const createExpBody = await createExpResponse.json();
    experimentId = createExpBody.experiment_id;
    const createPassExpResponse = await fetch(`${BASE_URL}/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': OWNER_ID },
      body: JSON.stringify({ name: PASSWORD_EXPERIMENT_NAME, password: EXPERIMENT_PASSWORD }),
    });
    const createPassExpBody = await createPassExpResponse.json();
    passwordExperimentId = createPassExpBody.experiment_id;
    console.log(`[Test Setup] Created public experiment: ${experimentId}`);
    console.log(`[Test Setup] Created password experiment: ${passwordExperimentId}`);
    await fetch(`${BASE_URL}/auth/experiments/${experimentId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: PARTICIPANT_ID }),
    });
    console.log(
      `[Test Setup] Pre-joined participant ${PARTICIPANT_ID} to experiment ${experimentId}`,
    );
  });

  afterAll(async () => {
    console.log('[Teardown] Starting afterAll hook...');
    await dbPool.end();
    console.log('[Teardown] PostgreSQL pool ended.');
    for (const fileName of stimulusFileNames) {
      try {
        await fs.unlink(path.join(ASSETS_DIR, fileName));
      } catch (error) {
        /* ignore */
      }
    }
    console.log(`[Teardown] Cleaned up dummy files.`);
    console.log('[Teardown] Forcing process exit...');
    process.exit(0);
  });

  describe('GET /experiments Authorization', () => {
    test('should return 400 if X-User-Id header is missing', async () => {
      console.log('\n🧪 [Test] Running Auth A: GET /experiments fails without user ID...');
      const response = await fetch(`${BASE_URL}/experiments`);
      expect(response.status).toBe(400);
      console.log('✅ [Test] Auth A Passed: Endpoint correctly requires X-User-Id.');
    });

    test('should return only joined experiments for a participant', async () => {
      console.log('\n🧪 [Test] Running Auth B: Participant sees only their experiment...');
      const response = await fetch(`${BASE_URL}/experiments`, {
        headers: { 'X-User-Id': PARTICIPANT_ID },
      });
      const experiments = await response.json();
      expect(response.status).toBe(200);
      expect(experiments).toBeArrayOfSize(1);
      expect(experiments[0].experiment_id).toBe(experimentId);
      console.log('✅ [Test] Auth B Passed: Participant sees exactly one experiment.');
    });

    test('should return all created experiments for an owner', async () => {
      console.log('\n🧪 [Test] Running Auth C: Owner sees all their experiments...');
      const response = await fetch(`${BASE_URL}/experiments`, {
        headers: { 'X-User-Id': OWNER_ID },
      });
      const experiments = await response.json();
      expect(response.status).toBe(200);
      expect(experiments).toBeArrayOfSize(2);
      const ids = experiments.map((exp: any) => exp.experiment_id);
      expect(ids).toContain(experimentId);
      expect(ids).toContain(passwordExperimentId);
      console.log('✅ [Test] Auth C Passed: Owner sees both created experiments.');
    });

    test('should return an empty array for a user with no experiments', async () => {
      console.log('\n🧪 [Test] Running Auth D: Stranger sees no experiments...');
      const response = await fetch(`${BASE_URL}/experiments`, {
        headers: { 'X-User-Id': STRANGER_ID },
      });
      const experiments = await response.json();
      expect(response.status).toBe(200);
      expect(experiments).toBeArrayOfSize(0);
      console.log('✅ [Test] Auth D Passed: Stranger sees an empty array.');
    });
  });

  describe('Full Workflow: Auth -> Session -> Stimulus -> DataLinker -> EventCorrector', () => {
    const SESSION_ID = `${PARTICIPANT_ID}-${Date.now()}-session`;
    const MOCKED_OBJECT_ID = `raw/${PARTICIPANT_ID}/${SESSION_ID}_test.zst`;

    test('should execute the full data processing pipeline', async () => {
      // Step 1: Owner registers stimuli
      console.log('\n🧪 [Test] Running Step 1: Register stimuli...');
      const formDataStimuli = new FormData();
      formDataStimuli.append(
        'stimuli_definition_csv',
        Bun.file(path.join(ASSETS_DIR, 'stimuli_definition.csv')),
      );
      for (const fileName of stimulusFileNames) {
        formDataStimuli.append(
          'stimulus_files',
          Bun.file(path.join(ASSETS_DIR, fileName)),
          fileName,
        );
      }
      const registerStimuliResponse = await fetch(
        `${BASE_URL}/experiments/${experimentId}/stimuli`,
        {
          method: 'POST',
          headers: { 'X-User-Id': OWNER_ID },
          body: formDataStimuli,
        },
      );
      expect(registerStimuliResponse.status).toBe(202);
      console.log('✅ [Test] Step 1 Passed: Stimulus registration accepted.');

      // Step 2: Poll to confirm stimulus job is done
      const registeredStimuli = await pollForStimuli(experimentId, stimulusFileNames.length);
      expect(registeredStimuli.map((s: any) => s.file_name).sort()).toEqual(
        stimulusFileNames.sort(),
      );
      console.log('✅ [Test] Step 2 Passed: Stimuli registration confirmed via polling.');

      // Step 3: Simulate Processor Service
      console.log('\n🧪 [Test] Running Step 3: Simulate Processor writing to DB...');
      const clockOffsetInfo = { offset_ms_avg: -150.5, rtt_ms_avg: 45.2 };
      const sessionStartTime = new Date(Date.now() - 10000);
      const sessionEndTime = new Date();

      const deviceStartTimeUs =
        BigInt(Math.round(sessionStartTime.getTime() - clockOffsetInfo.offset_ms_avg)) * 1000n;

      const numPoints = 128;
      const sampleIntervalUs = BigInt(Math.floor(1000000 / 256));
      const deviceEndTimeUs = deviceStartTimeUs + BigInt(numPoints - 1) * sampleIntervalUs;

      await dbPool.query(
        `INSERT INTO raw_data_objects (object_id, user_id, device_id, start_time_device, end_time_device)
         VALUES ($1, $2, 'test-device-123', $3, $4) ON CONFLICT (object_id) DO NOTHING`,
        [
          MOCKED_OBJECT_ID,
          PARTICIPANT_ID,
          deviceStartTimeUs.toString(),
          deviceEndTimeUs.toString(),
        ],
      );
      console.log(
        '✅ [Test] Step 3 Passed: Pre-inserted raw data object with realistic timestamps.',
      );

      // Step 3.5: Upload mock data file
      console.log('\n🧪 [Test] Running Step 3.5: Uploading mock data file to MinIO...');
      const mockBuffer = createMockDeviceDataBuffer(numPoints, [10, 50], deviceStartTimeUs);
      const compressedContent = compress(mockBuffer);
      await minioClient.putObject(
        MINIO_RAW_DATA_BUCKET,
        MOCKED_OBJECT_ID,
        Buffer.from(compressedContent),
      );
      console.log(`✅ [Test] Step 3.5 Passed: Uploaded mock file: ${MOCKED_OBJECT_ID}`);

      // Step 4: Participant starts and ends a session
      console.log('\n🧪 [Test] Running Step 4: Participant starts and ends session...');
      await fetch(`${BASE_URL}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': PARTICIPANT_ID },
        body: JSON.stringify({
          session_id: SESSION_ID,
          user_id: PARTICIPANT_ID,
          experiment_id: experimentId,
          start_time: sessionStartTime.toISOString(),
          session_type: 'main_external',
        }),
      });
      const formDataEnd = new FormData();
      formDataEnd.append(
        'metadata',
        JSON.stringify({
          session_id: SESSION_ID,
          user_id: PARTICIPANT_ID,
          experiment_id: experimentId,
          device_id: 'test-device-123',
          start_time: sessionStartTime.toISOString(),
          end_time: sessionEndTime.toISOString(),
          session_type: 'main_external',
          clock_offset_info: clockOffsetInfo,
        }),
      );
      formDataEnd.append('events_log_csv', Bun.file(path.join(ASSETS_DIR, 'events_log.csv')));
      const endSessionResponse = await fetch(`${BASE_URL}/sessions/end`, {
        method: 'POST',
        headers: { 'X-User-Id': PARTICIPANT_ID },
        body: formDataEnd,
      });
      expect(endSessionResponse.status).toBe(200);
      console.log('✅ [Test] Step 4 Passed: Session ended, async jobs enqueued.');

      // Step 5: Poll for DataLinker
      console.log('\n🧪 [Test] Running Step 5: Polling DB for DataLinker completion...');
      await pollForDbStatus(
        dbPool,
        'SELECT link_status as status FROM sessions WHERE session_id = $1',
        [SESSION_ID],
        'completed',
      );
      console.log('✅ [Test] Step 5 Passed: link_status is "completed".');

      // Step 6: Verify DataLinker results
      console.log('\n🧪 [Test] Running Step 6: Verifying DataLinker results...');
      const objRes = await dbPool.query(
        'SELECT start_time, end_time FROM raw_data_objects WHERE object_id = $1',
        [MOCKED_OBJECT_ID],
      );
      expect(objRes.rows[0].start_time).not.toBeNull();
      console.log('✅ [Test] Step 6.1 Passed: raw_data_objects timestamps are normalized.');
      const linkRes = await dbPool.query(
        'SELECT * FROM session_object_links WHERE session_id = $1 AND object_id = $2',
        [SESSION_ID, MOCKED_OBJECT_ID],
      );
      expect(linkRes.rows).toHaveLength(1);
      console.log('✅ [Test] Step 6.2 Passed: session_object_links record created.');

      // Step 7: Poll for EventCorrector
      console.log('\n🧪 [Test] Running Step 7: Polling DB for EventCorrector completion...');
      await pollForDbStatus(
        dbPool,
        'SELECT event_correction_status as status FROM sessions WHERE session_id = $1',
        [SESSION_ID],
        'completed',
      );
      console.log('✅ [Test] Step 7 Passed: event_correction_status is "completed".');

      // Step 8: Verify EventCorrector results
      const eventsRes = await dbPool.query(
        'SELECT onset_corrected_us FROM session_events WHERE session_id = $1 ORDER BY onset ASC',
        [SESSION_ID],
      );
      expect(eventsRes.rowCount).toBe(2);
      expect(eventsRes.rows[0].onset_corrected_us).not.toBeNull();
      expect(eventsRes.rows[1].onset_corrected_us).not.toBeNull();
      console.log('✅ [Test] Step 8 Passed: Event onsets were corrected with device timestamps.');
    }, 30000);
  });

  describe('Password Protection Workflow', () => {
    test('should correctly handle joining a password-protected experiment', async () => {
      console.log('\n🧪 [Test] Running Password Step 1: Fail to join without password...');
      const joinNoPassResponse = await fetch(
        `${BASE_URL}/auth/experiments/${passwordExperimentId}/join`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: STRANGER_ID }),
        },
      );
      expect(joinNoPassResponse.status).toBe(401);
      console.log('✅ [Test] Password Step 1 Passed: Rejected join attempt without password.');

      console.log('\n🧪 [Test] Running Password Step 2: Fail to join with incorrect password...');
      const joinWrongPassResponse = await fetch(
        `${BASE_URL}/auth/experiments/${passwordExperimentId}/join`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: STRANGER_ID, password: 'wrongpassword' }),
        },
      );
      expect(joinWrongPassResponse.status).toBe(401);
      console.log(
        '✅ [Test] Password Step 2 Passed: Rejected join attempt with incorrect password.',
      );

      console.log(
        '\n🧪 [Test] Running Password Step 3: Successfully join with correct password...',
      );
      const joinCorrectPassResponse = await fetch(
        `${BASE_URL}/auth/experiments/${passwordExperimentId}/join`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: STRANGER_ID, password: EXPERIMENT_PASSWORD }),
        },
      );
      expect(joinCorrectPassResponse.status).toBe(201);
      console.log(
        '✅ [Test] Password Step 3 Passed: Successfully joined password-protected experiment.',
      );
    });
  });

  describe('Idempotency Tests', () => {
    test('POST /sessions/end should be idempotent', async () => {
      console.log('\n🧪 [Test] Running Idempotency Test for /sessions/end...');
      const IDEMPOTENT_SESSION_ID = `${PARTICIPANT_ID}-${Date.now()}-idempotent`;
      const startTime = new Date(Date.now() - 10000);
      const endTime = new Date();

      const IDEMPOTENT_MOCKED_OBJECT_ID = `raw/${PARTICIPANT_ID}/${IDEMPOTENT_SESSION_ID}_test.zst`;
      const deviceStartTimeUs = BigInt(startTime.getTime()) * 1000n;
      const deviceEndTimeUs = BigInt(endTime.getTime()) * 1000n;
      await dbPool.query(
        `INSERT INTO raw_data_objects (object_id, user_id, device_id, start_time_device, end_time_device)
         VALUES ($1, $2, 'idempotent-device', $3, $4) ON CONFLICT (object_id) DO NOTHING`,
        [
          IDEMPOTENT_MOCKED_OBJECT_ID,
          PARTICIPANT_ID,
          deviceStartTimeUs.toString(),
          deviceEndTimeUs.toString(),
        ],
      );

      await fetch(`${BASE_URL}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': PARTICIPANT_ID },
        body: JSON.stringify({
          session_id: IDEMPOTENT_SESSION_ID,
          user_id: PARTICIPANT_ID,
          experiment_id: experimentId,
          start_time: startTime.toISOString(),
          session_type: 'main_external',
        }),
      });
      const formDataEnd = new FormData();
      formDataEnd.append(
        'metadata',
        JSON.stringify({
          session_id: IDEMPOTENT_SESSION_ID,
          user_id: PARTICIPANT_ID,
          experiment_id: experimentId,
          device_id: 'idempotent-device',
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          session_type: 'main_external',
        }),
      );
      formDataEnd.append('events_log_csv', Bun.file(path.join(ASSETS_DIR, 'events_log.csv')));
      const response1 = await fetch(`${BASE_URL}/sessions/end`, {
        method: 'POST',
        headers: { 'X-User-Id': PARTICIPANT_ID },
        body: formDataEnd,
      });
      expect(response1.status).toBe(200);
      console.log('✅ [Test] First /sessions/end call successful.');
      let eventRows = await dbPool.query('SELECT * FROM session_events WHERE session_id = $1', [
        IDEMPOTENT_SESSION_ID,
      ]);
      expect(eventRows.rowCount).toBe(2);
      console.log('...Sending the exact same /sessions/end request again...');
      const response2 = await fetch(`${BASE_URL}/sessions/end`, {
        method: 'POST',
        headers: { 'X-User-Id': PARTICIPANT_ID },
        body: formDataEnd,
      });
      expect(response2.status).toBe(200);
      console.log('✅ [Test] Second /sessions/end call successful.');
      eventRows = await dbPool.query('SELECT * FROM session_events WHERE session_id = $1', [
        IDEMPOTENT_SESSION_ID,
      ]);
      expect(eventRows.rowCount).toBe(2);
      console.log(
        '✅ [Test] Idempotency confirmed: event count remains correct after duplicate request.',
      );
    });
  });

  describe('BIDS Exporter Workflow', () => {
    test('should successfully export and verify the BIDS dataset content', async () => {
      console.log('\n🧪 [Test] Running BIDS Exporter Workflow...');

      // BIDS Exporterが非同期処理を完了するのを待つためのスリープを追加
      console.log('[BIDS Test] Waiting 10 seconds for backend processing to settle...');
      await sleep(10000);

      let tempDir: string | null = null;
      try {
        // Step 1: Kick off export task
        console.log('[BIDS Test] Step 1: Kicking off export task...');
        const startResponse = await fetch(`${BASE_URL}/experiments/${experimentId}/export`, {
          method: 'POST',
        });
        expect(startResponse.status).toBe(202);
        const startBody = await startResponse.json();
        const taskId = startBody.task_id;
        expect(taskId).toBeString();
        console.log(`✅ [BIDS Test] Step 1 Passed: Export task started with ID: ${taskId}`);

        // Step 2: Poll for task completion
        console.log('[BIDS Test] Step 2: Polling for task completion (this may take a moment)...');
        const completedTask = await pollForTaskStatus(taskId, 'completed');
        expect(completedTask.status).toBe('completed');
        expect(completedTask.progress).toBe(100);
        expect(completedTask.result_file_path).not.toBeNull();
        console.log('✅ [BIDS Test] Step 2 Passed: Task polling confirmed completion.');

        // Step 3: Get the download URL (API now returns 200 OK directly)
        console.log('[BIDS Test] Step 3: Verifying download endpoint...');
        const downloadResponse = await fetch(`${BASE_URL}/export-tasks/${taskId}/download`);

        if (!downloadResponse.ok) {
          console.error(
            `[BIDS Test] DEBUG: Failed to download the zip file. Status: ${downloadResponse.status} ${downloadResponse.statusText}`,
          );
          const errorBody = await downloadResponse.text();
          console.error(`[BIDS Test] DEBUG: BIDS Exporter Response Body:`, errorBody);
        }

        expect(downloadResponse.status).toBe(200);
        expect(downloadResponse.headers.get('content-type')).toContain('application/zip');
        console.log(
          `✅ [BIDS Test] Step 3 Passed: Download endpoint returned 200 OK with correct content type.`,
        );

        // Step 4: Verify the content
        console.log('[BIDS Test] Step 4: Verifying BIDS archive content...');

        // Create a temporary directory for extraction
        tempDir = await fs.mkdtemp(path.join('/tmp', 'bids-verify-'));
        const zipPath = path.join(tempDir, 'bids_export.zip');
        await Bun.write(zipPath, await downloadResponse.arrayBuffer());

        // Unzip the file using the system's unzip command
        const unzipProc = Bun.spawnSync(['unzip', zipPath, '-d', tempDir]);

        if (!unzipProc.success) {
          console.error('[BIDS Test] DEBUG: unzip command failed.');
          console.error(
            '[BIDS Test] DEBUG: unzip stdout:',
            new TextDecoder().decode(unzipProc.stdout),
          );
          console.error(
            '[BIDS Test] DEBUG: unzip stderr:',
            new TextDecoder().decode(unzipProc.stderr),
          );
        }
        expect(unzipProc.success).toBe(true);

        // ### <<< 修正点 >>> ###
        // BIDS Exporterの実装に合わせて、期待されるtask名を `session_type` から生成します。
        // 'main_external' -> 'mainexternal'
        const subjectId = PARTICIPANT_ID.replace(/-/g, '');
        const taskName = 'mainexternal';
        const bidsBasePath = path.join(tempDir, 'bids_dataset', `sub-${subjectId}`, 'ses-1', 'eeg');
        const sidecarPath = path.join(
          bidsBasePath,
          `sub-${subjectId}_ses-1_task-${taskName}_eeg.json`,
        );
        const channelsPath = path.join(
          bidsBasePath,
          `sub-${subjectId}_ses-1_task-${taskName}_channels.tsv`,
        );

        // Verify _eeg.json content
        console.log('[BIDS Test] Verifying _eeg.json...');
        const sidecarContent = await fs.readFile(sidecarPath, 'utf-8');
        const sidecarJson = JSON.parse(sidecarContent);
        expect(sidecarJson.PowerLineFrequency).toBe(50);
        expect(sidecarJson.EEGReference).toBe('n/a');
        console.log('✅ [BIDS Test] _eeg.json verification passed.');

        // Verify _channels.tsv content
        console.log('[BIDS Test] Verifying _channels.tsv...');
        const channelsContent = await fs.readFile(channelsPath, 'utf-8');
        const lines = channelsContent.trim().split('\n');
        const header = lines.shift()!.split('\t');
        const statusIndex = header.indexOf('status');
        expect(statusIndex).not.toBe(-1); // Check that the 'status' column exists
        for (const line of lines) {
          const values = line.split('\t');
          expect(values[statusIndex]).toBe('good'); // Check that status is 'good'
        }
        console.log('✅ [BIDS Test] _channels.tsv verification passed.');
      } finally {
        // Clean up the temporary directory
        if (tempDir) {
          await fs.rm(tempDir, { recursive: true, force: true });
          console.log(`[BIDS Test] Cleaned up temporary directory: ${tempDir}`);
        }
      }
    }, 90000);
  });
});
