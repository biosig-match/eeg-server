import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

// --- Test Configuration ---
const BASE_URL = 'http://localhost:8080/api/v1';

const OWNER_ID = `test-owner-${Date.now()}`;
const PARTICIPANT_ID = `test-participant-${Date.now()}`;
const STRANGER_ID = `test-stranger-${Date.now()}`;
const EXPERIMENT_NAME = `Test Experiment ${Date.now()}`;
const PASSWORD_EXPERIMENT_NAME = `Password Protected Experiment ${Date.now()}`;
const EXPERIMENT_PASSWORD = 'strongpassword123';
const SESSION_ID = `${PARTICIPANT_ID}-${Date.now()}-session`;

const ASSETS_DIR = path.resolve(__dirname, '../assets');

// --- Helper Functions ---
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls the stimulus API endpoint until the expected number of stimuli are found or timeout is reached.
 * @param experimentId The ID of the experiment to check.
 * @param expectedCount The number of stimuli expected to be registered.
 * @param timeout The maximum time to wait in milliseconds.
 * @param interval The polling interval in milliseconds.
 */
async function pollForStimuli(
  experimentId: string,
  expectedCount: number,
  timeout = 10000,
  interval = 500,
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
      console.log(`[Polling] Found ${stimuli.length} stimuli, waiting for ${expectedCount}...`);
    } else if (response.status !== 404) {
      // 404 might just mean the records aren't created yet, but other errors are problems.
      console.log(`[Polling] API returned status ${response.status}. Retrying...`);
    }

    await sleep(interval);
  }
  throw new Error(`Polling for stimuli timed out after ${timeout}ms.`);
}

// Helper to dynamically create dummy image files for testing
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

// --- Test Suite ---
describe('E2E Test for Core Service Integration', () => {
  const stimulusFileNames = ['test_stimulus_1.png', 'test_stimulus_2.png'];
  let experimentId: string;
  let passwordExperimentId: string;

  beforeAll(async () => {
    await createDummyImageFiles(ASSETS_DIR, stimulusFileNames);

    // Create a public experiment for general tests
    const createExpResponse = await fetch(`${BASE_URL}/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': OWNER_ID },
      body: JSON.stringify({ name: EXPERIMENT_NAME }),
    });
    const createExpBody = await createExpResponse.json();
    experimentId = createExpBody.experiment_id;

    // Create a password-protected experiment
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
    for (const fileName of stimulusFileNames) {
      try {
        await fs.unlink(path.join(ASSETS_DIR, fileName));
      } catch (error) {
        // Ignore errors if file doesn't exist
      }
    }
    console.log(`[Test Teardown] Cleaned up dummy files.`);
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

  describe('Full Workflow and Permissions', () => {
    test('should execute the user workflow and enforce access controls', async () => {
      // Step 1: Verify Owner is listed correctly
      console.log('\n🧪 [Test] Running Step 1: Verify Owner...');
      const getParticipantsResponse1 = await fetch(
        `${BASE_URL}/auth/experiments/${experimentId}/participants`,
        { headers: { 'X-User-Id': OWNER_ID } },
      );
      const participantsBody1 = await getParticipantsResponse1.json();
      expect(getParticipantsResponse1.status).toBe(200);
      const owner = participantsBody1.find((p: any) => p.user_id === OWNER_ID);
      expect(owner).toBeDefined();
      expect(owner.role).toBe('owner');
      console.log(`✅ [Test] Step 1 Passed: Verified ${OWNER_ID} is the owner.`);

      // Step 2: (FAIL) Stranger tries to get participants list
      console.log('\n🧪 [Test] Running Step 2: Stranger fails to get participants...');
      const strangerGetResponse = await fetch(
        `${BASE_URL}/auth/experiments/${experimentId}/participants`,
        { headers: { 'X-User-Id': STRANGER_ID } },
      );
      expect(strangerGetResponse.status).toBe(403);
      console.log('✅ [Test] Step 2 Passed: Stranger was forbidden from viewing participants.');

      // Step 3: (FAIL) Owner tries to register stimuli with mismatched files
      console.log('\n🧪 [Test] Running Step 3: Fail to register stimuli with mismatch...');
      const formDataMismatch = new FormData();
      formDataMismatch.append(
        'stimuli_definition_csv',
        Bun.file(path.join(ASSETS_DIR, 'stimuli_definition.csv')),
      );
      // CSV expects 2 files, but we only send one
      formDataMismatch.append(
        'stimulus_files',
        Bun.file(path.join(ASSETS_DIR, stimulusFileNames[0])),
        stimulusFileNames[0],
      );
      const registerStimuliMismatchResponse = await fetch(
        `${BASE_URL}/experiments/${experimentId}/stimuli`,
        {
          method: 'POST',
          headers: { 'X-User-Id': OWNER_ID },
          body: formDataMismatch,
        },
      );
      expect(registerStimuliMismatchResponse.status).toBe(400);
      console.log(
        '✅ [Test] Step 3 Passed: Stimuli registration failed as expected due to file mismatch.',
      );

      // Step 4: Owner registers stimuli successfully and verify with polling
      console.log('\n🧪 [Test] Running Step 4: Register Stimuli successfully...');
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
      console.log('✅ [Test] Step 4.1 Passed: Stimulus registration accepted.');

      console.log('...Polling to confirm async stimulus processor job completion...');
      const registeredStimuli = await pollForStimuli(experimentId, stimulusFileNames.length);
      expect(registeredStimuli).toBeArrayOfSize(stimulusFileNames.length);
      expect(registeredStimuli.map((s: any) => s.file_name).sort()).toEqual(
        stimulusFileNames.sort(),
      );
      console.log(
        '✅ [Test] Step 4.2 Passed: Polling confirmed stimuli were successfully processed and saved to DB.',
      );

      // Step 5: (FAIL) Participant tries to register stimuli (they are not an owner)
      console.log('\n🧪 [Test] Running Step 5: A participant fails to register stimuli...');
      const participantStimuliResponse = await fetch(
        `${BASE_URL}/experiments/${experimentId}/stimuli`,
        {
          method: 'POST',
          headers: { 'X-User-Id': PARTICIPANT_ID },
          body: formDataStimuli,
        },
      );
      expect(participantStimuliResponse.status).toBe(403);
      console.log('✅ [Test] Step 5 Passed: Participant was forbidden from registering stimuli.');

      // Step 6 & 7 are covered by beforeAll and the participants check in Step 1
      console.log('\n🧪 [Test] Steps 6 & 7: User joining and verification already covered.');

      // Step 8: (FAIL) Participant tries to get participants list
      console.log('\n🧪 [Test] Running Step 8: Participant fails to get participants list...');
      const participantGetResponse = await fetch(
        `${BASE_URL}/auth/experiments/${experimentId}/participants`,
        { headers: { 'X-User-Id': PARTICIPANT_ID } },
      );
      expect(participantGetResponse.status).toBe(403);
      console.log('✅ [Test] Step 8 Passed: Participant was forbidden from viewing participants.');

      // Step 9: (SUCCESS) Participant starts and ends a session
      console.log('\n🧪 [Test] Running Step 9: Participant starts and ends a session...');
      const startSessionResponse = await fetch(`${BASE_URL}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': PARTICIPANT_ID },
        body: JSON.stringify({
          session_id: SESSION_ID,
          user_id: PARTICIPANT_ID,
          experiment_id: experimentId,
          start_time: new Date().toISOString(),
          session_type: 'main_integrated',
        }),
      });
      expect(startSessionResponse.status).toBe(201);

      const formDataEnd = new FormData();
      formDataEnd.append(
        'metadata',
        JSON.stringify({
          session_id: SESSION_ID,
          user_id: PARTICIPANT_ID,
          experiment_id: experimentId,
          device_id: 'test-device-123',
          start_time: new Date(Date.now() - 10000).toISOString(),
          end_time: new Date().toISOString(),
          session_type: 'main_integrated',
          clock_offset_info: {
            offset_ms_avg: -150.5,
            rtt_ms_avg: 45.2,
          },
        }),
      );
      formDataEnd.append('events_log_csv', Bun.file(path.join(ASSETS_DIR, 'events_log.csv')));
      const endSessionResponse = await fetch(`${BASE_URL}/sessions/end`, {
        method: 'POST',
        headers: { 'X-User-Id': PARTICIPANT_ID },
        body: formDataEnd,
      });
      const endSessionBodyText = await endSessionResponse.text();
      expect(
        endSessionResponse.status,
        `Step 9 Failed (End Session). Body: ${endSessionBodyText}`,
      ).toBe(200);
      console.log(`✅ [Test] Step 9 Passed: Session started and ended successfully.`);

      // Step 10: (SUCCESS) Participant starts and ends a calibration session
      console.log(
        '\n🧪 [Test] Running Step 10: Participant starts and ends a calibration session...',
      );
      const CALIBRATION_SESSION_ID = `${PARTICIPANT_ID}-${Date.now()}-calibration`;
      const startCalSessionResponse = await fetch(`${BASE_URL}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': PARTICIPANT_ID },
        body: JSON.stringify({
          session_id: CALIBRATION_SESSION_ID,
          user_id: PARTICIPANT_ID,
          experiment_id: experimentId,
          start_time: new Date().toISOString(),
          session_type: 'calibration',
        }),
      });
      expect(startCalSessionResponse.status).toBe(201);

      const formDataCalEnd = new FormData();
      formDataCalEnd.append(
        'metadata',
        JSON.stringify({
          session_id: CALIBRATION_SESSION_ID,
          user_id: PARTICIPANT_ID,
          experiment_id: experimentId,
          device_id: 'test-device-cal-123',
          start_time: new Date(Date.now() - 5000).toISOString(),
          end_time: new Date().toISOString(),
          session_type: 'calibration',
          clock_offset_info: {
            offset_ms_avg: -152.1,
            rtt_ms_avg: 48.9,
          },
        }),
      );
      const endCalSessionResponse = await fetch(`${BASE_URL}/sessions/end`, {
        method: 'POST',
        headers: { 'X-User-Id': PARTICIPANT_ID },
        body: formDataCalEnd,
      });
      const endCalSessionBodyText = await endCalSessionResponse.text();
      expect(
        endCalSessionResponse.status,
        `Step 10 Failed (End Calibration Session). Body: ${endCalSessionBodyText}`,
      ).toBe(200);
      console.log('✅ [Test] Step 10 Passed: Calibration session started and ended successfully.');
    }, 30000);
  });

  describe('Password Protection Workflow', () => {
    test('should correctly handle joining a password-protected experiment', async () => {
      // Step 1: (FAIL) Join without password
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

      // Step 2: (FAIL) Join with incorrect password
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

      // Step 3: (SUCCESS) Join with correct password
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
});
