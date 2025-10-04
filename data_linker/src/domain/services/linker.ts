import { PoolClient } from 'pg'
import { dbPool } from '../../infrastructure/db'
import type { DataLinkerJobPayload } from '../../app/schemas/job'
import { getAmqpChannel } from '../../infrastructure/queue'
import { config } from '../../config/env'

/**
 * The main handler for a single DataLinker job.
 * Executes all database operations within a single transaction.
 * @param job - The validated job payload from the queue.
 */
export async function handleLinkerJob(job: DataLinkerJobPayload): Promise<void> {
  console.log(`[Job] Starting: Linking data for session ${job.session_id}`);
  const dbClient = await dbPool.connect();

  try {
    await dbClient.query('BEGIN');

    const sessionRes = await dbClient.query('SELECT * FROM sessions WHERE session_id = $1', [
      job.session_id,
    ]);

    if (sessionRes.rowCount === 0) {
      throw new Error(`Session ${job.session_id} not found in the database.`);
    }

    const session = sessionRes.rows[0];

    // ### <<< ログ強化 >>> ###
    console.log(
      `[Job Details] Processing session: ${session.session_id}, User: ${session.user_id}`,
    );
    console.log(
      `[Job Details] Session Time Range (UTC): ${new Date(
        session.start_time,
      ).toISOString()} to ${new Date(session.end_time).toISOString()}`,
    );

    await dbClient.query("UPDATE sessions SET link_status = 'processing' WHERE session_id = $1", [
      job.session_id,
    ]);

    await normalizeRawObjectTimestamps(dbClient, session);

    await linkRawObjectsToSession(dbClient, session);
    await linkMediaToExperiment(dbClient, session);

    await dbClient.query("UPDATE sessions SET link_status = 'completed' WHERE session_id = $1", [
      job.session_id,
    ]);

    const eventCorrectorJob = { session_id: job.session_id };
    getAmqpChannel().sendToQueue(
      config.EVENT_CORRECTION_QUEUE,
      Buffer.from(JSON.stringify(eventCorrectorJob)),
      { persistent: true },
    );
    console.log(`[Job] Enqueued job for EventCorrector for session: ${job.session_id}`);

    await dbClient.query('COMMIT');
    console.log(`[Job] ✅ Success: Finished linking for session ${job.session_id}`);
  } catch (error) {
    await dbClient.query('ROLLBACK');
    console.error(`[Job] ❌ Failure: Rolled back transaction for session ${job.session_id}`, error);
    await dbPool.query("UPDATE sessions SET link_status = 'failed' WHERE session_id = $1", [
      job.session_id,
    ]);
    throw error;
  } finally {
    dbClient.release();
  }
}

const UINT32_RANGE = 0x1_0000_0000n;
const UINT32_MASK = 0xffff_ffffn;

function toBigInt(value: unknown): bigint {
  return typeof value === 'bigint' ? value : BigInt(value as string | number);
}

function diffUnsigned32(base: bigint, current: bigint): bigint {
  let diff = current - base;
  if (diff < 0n) {
    diff += UINT32_RANGE;
  }
  return diff;
}

async function normalizeRawObjectTimestamps(dbClient: PoolClient, session: any) {
  const { user_id: userId, session_id: sessionId, start_time: sessionStart, end_time: sessionEnd } = session;
  const offsetMs = session.clock_offset_info?.offset_ms_avg ?? 0;
  console.log(
    `[Normalize] Using offset: ${offsetMs} ms for user ${userId} (session ${sessionId}).`,
  );

  if (!sessionStart) {
    console.warn(`[Normalize] Session ${sessionId} is missing start_time. Skipping normalization.`);
    return;
  }

  const sessionStartMs = new Date(sessionStart).getTime();
  const fallbackDurationMs = 60_000; // fallback to 1 minute window if end_time is unavailable
  const sessionEndMs = sessionEnd ? new Date(sessionEnd).getTime() : sessionStartMs + fallbackDurationMs;
  const sessionDurationMs = Math.max(sessionEndMs - sessionStartMs, 1_000);
  const toleranceMs = 10_000;
  const lowerBoundIso = new Date(sessionStartMs - toleranceMs).toISOString();
  const upperBoundIso = new Date(sessionEndMs + toleranceMs).toISOString();

  const candidateRes = await dbClient.query<{
    object_id: string;
    start_time_device: string;
    end_time_device: string;
    start_time: Date | null;
  }>(
    `SELECT object_id, start_time_device, end_time_device, start_time
     FROM raw_data_objects
     WHERE user_id = $1
       AND start_time_device IS NOT NULL
       AND end_time_device IS NOT NULL
       AND (start_time IS NULL OR start_time < $2 OR start_time > $3)` ,
    [userId, lowerBoundIso, upperBoundIso],
  );

  if (candidateRes.rows.length === 0) {
    console.log('[Normalize] No raw data objects require normalization for this session.');
    return;
  }
  console.log(`[Normalize] Considering ${candidateRes.rows.length} raw objects for session ${sessionId}.`);

  const expectedDeviceStartUsFull =
    BigInt(Math.round(sessionStartMs - offsetMs)) * 1000n;
  const deviceBase = expectedDeviceStartUsFull & UINT32_MASK;

  const maxSessionWindowUs = BigInt((sessionDurationMs + toleranceMs) * 1000);

  let normalizedCount = 0;

  for (const row of candidateRes.rows) {
    const startDevice = toBigInt(row.start_time_device) & UINT32_MASK;
    const endDevice = toBigInt(row.end_time_device) & UINT32_MASK;

    const startDeltaUs = diffUnsigned32(deviceBase, startDevice);
    const endDeltaUs = diffUnsigned32(deviceBase, endDevice);

    if (startDeltaUs > maxSessionWindowUs) {
      continue; // Likely belongs to a different session; skip.
    }

    const startUtcMs = sessionStartMs + Number(startDeltaUs / 1000n);
    const endUtcMs = sessionStartMs + Number(endDeltaUs / 1000n);

    const startIso = new Date(startUtcMs).toISOString();
    const endIso = new Date(endUtcMs).toISOString();

    await dbClient.query(
      `UPDATE raw_data_objects
       SET start_time = $1, end_time = $2
       WHERE object_id = $3`,
      [startIso, endIso, row.object_id],
    );
    normalizedCount += 1;
  }

  console.log(
    `[Normalize] Updated ${normalizedCount} raw data objects for session ${sessionId}.`,
  );
}

async function linkRawObjectsToSession(dbClient: PoolClient, session: any) {
  // ### <<< ログ強化 >>> ###
  const preCheckQuery = `
    SELECT object_id, start_time, end_time
    FROM raw_data_objects
    WHERE user_id = $1 AND start_time IS NOT NULL AND end_time IS NOT NULL
  `;
  const preCheckResult = await dbClient.query(preCheckQuery, [session.user_id]);
  const preCheckCount = preCheckResult.rowCount ?? 0;
  console.log(
    `[Link] Pre-check: Found ${preCheckCount} normalized raw data objects for user ${session.user_id}.`,
  );
  if (preCheckCount > 0) {
    preCheckResult.rows.forEach((row, index) => {
      console.log(
        `[Link] Pre-check Object #${index + 1}: ${row.object_id} -> Time Range (UTC): ${new Date(
          row.start_time,
        ).toISOString()} to ${new Date(row.end_time).toISOString()}`,
      );
    });
  }

  const linkQuery = `
    INSERT INTO session_object_links (session_id, object_id)
    SELECT $1, object_id
    FROM raw_data_objects
    WHERE
      user_id = $2
      AND start_time IS NOT NULL
      AND end_time IS NOT NULL
      AND TSTZRANGE(start_time, end_time) && TSTZRANGE($3::timestamptz, $4::timestamptz)
    ON CONFLICT (session_id, object_id) DO NOTHING;
  `;
  const result = await dbClient.query(linkQuery, [
    session.session_id,
    session.user_id,
    session.start_time,
    session.end_time,
  ]);
  const rowsAffected = result.rowCount ?? 0;
  console.log(
    `[Link] Attempted to link raw data objects for session ${session.session_id}. Rows affected: ${rowsAffected}.`,
  );
}

async function linkMediaToExperiment(dbClient: PoolClient, session: any) {
  const imageUpdateRes = await dbClient.query(
    `UPDATE images SET experiment_id = $1 WHERE session_id = $2 AND experiment_id IS NULL`,
    [session.experiment_id, session.session_id],
  );
  const imageRowCount = imageUpdateRes.rowCount ?? 0;
  if (imageRowCount > 0) {
    console.log(
      `[Link] Linked ${imageRowCount} images to experiment ${session.experiment_id}.`,
    );
  }
  const audioUpdateRes = await dbClient.query(
    `UPDATE audio_clips SET experiment_id = $1 WHERE session_id = $2 AND experiment_id IS NULL`,
    [session.experiment_id, session.session_id],
  );
  const audioRowCount = audioUpdateRes.rowCount ?? 0;
  if (audioRowCount > 0) {
    console.log(
      `[Link] Linked ${audioRowCount} audio clips to experiment ${session.experiment_id}.`,
    );
  }
}
