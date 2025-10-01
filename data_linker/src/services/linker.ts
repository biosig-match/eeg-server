import { PoolClient } from 'pg';
import { dbPool } from '../lib/db';
import type { DataLinkerJobPayload } from '../schemas/job';
import { getAmqpChannel } from '../lib/queue';
import { config } from '../lib/config';

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
    const clockOffsetInfo = session.clock_offset_info;

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

    if (clockOffsetInfo) {
      await normalizeRawObjectTimestamps(dbClient, session.user_id, clockOffsetInfo);
    } else {
      console.warn(
        `[Job] No clock_offset_info for session ${job.session_id}. Skipping timestamp normalization.`,
      );
    }

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

async function normalizeRawObjectTimestamps(
  dbClient: PoolClient,
  userId: string,
  clockOffsetInfo: any,
) {
  const offsetMs = clockOffsetInfo.offset_ms_avg;
  console.log(`[Normalize] Using offset: ${offsetMs} ms for user ${userId}`);
  const findRes = await dbClient.query<{
    object_id: string;
    start_time_device: string;
    end_time_device: string;
  }>(
    `SELECT object_id, start_time_device, end_time_device
     FROM raw_data_objects
     WHERE user_id = $1 AND start_time IS NULL`,
    [userId],
  );

  if (findRes.rows.length === 0) {
    console.log('[Normalize] No new raw data objects found to normalize.');
    return;
  }
  console.log(`[Normalize] Found ${findRes.rows.length} objects to process.`);

  for (const row of findRes.rows) {
    const startTimeDeviceMs = BigInt(row.start_time_device) / 1000n;
    const endTimeDeviceMs = BigInt(row.end_time_device) / 1000n;
    const startTimeUtc = new Date(Number(startTimeDeviceMs) + offsetMs);
    const endTimeUtc = new Date(Number(endTimeDeviceMs) + offsetMs);

    await dbClient.query(
      `UPDATE raw_data_objects
       SET start_time = $1, end_time = $2
       WHERE object_id = $3`,
      [startTimeUtc.toISOString(), endTimeUtc.toISOString(), row.object_id],
    );
  }
  console.log(`[Normalize] Finished normalizing timestamps for ${findRes.rows.length} objects.`);
}

async function linkRawObjectsToSession(dbClient: PoolClient, session: any) {
  // ### <<< ログ強化 >>> ###
  const preCheckQuery = `
    SELECT object_id, start_time, end_time
    FROM raw_data_objects
    WHERE user_id = $1 AND start_time IS NOT NULL AND end_time IS NOT NULL
  `;
  const preCheckResult = await dbClient.query(preCheckQuery, [session.user_id]);
  console.log(
    `[Link] Pre-check: Found ${preCheckResult.rowCount} normalized raw data objects for user ${session.user_id}.`,
  );
  if (preCheckResult.rowCount > 0) {
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
  console.log(
    `[Link] Attempted to link raw data objects for session ${session.session_id}. Rows affected: ${result.rowCount}.`,
  );
}

async function linkMediaToExperiment(dbClient: PoolClient, session: any) {
  const imageUpdateRes = await dbClient.query(
    `UPDATE images SET experiment_id = $1 WHERE session_id = $2 AND experiment_id IS NULL`,
    [session.experiment_id, session.session_id],
  );
  if (imageUpdateRes.rowCount > 0) {
    console.log(
      `[Link] Linked ${imageUpdateRes.rowCount} images to experiment ${session.experiment_id}.`,
    );
  }
  const audioUpdateRes = await dbClient.query(
    `UPDATE audio_clips SET experiment_id = $1 WHERE session_id = $2 AND experiment_id IS NULL`,
    [session.experiment_id, session.session_id],
  );
  if (audioUpdateRes.rowCount > 0) {
    console.log(
      `[Link] Linked ${audioUpdateRes.rowCount} audio clips to experiment ${session.experiment_id}.`,
    );
  }
}
