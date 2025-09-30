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
    // ★★★ 修正箇所 ★★★ // データベースから最新のセッション情報を取得して使用する
    await dbClient.query('BEGIN');

    const sessionRes = await dbClient.query('SELECT * FROM sessions WHERE session_id = $1', [
      job.session_id,
    ]);

    if (sessionRes.rowCount === 0) {
      throw new Error(`Session ${job.session_id} not found in the database.`);
    }

    const session = sessionRes.rows[0];
    const clockOffsetInfo = session.clock_offset_info;

    // 1. Update session status to 'processing'
    await dbClient.query("UPDATE sessions SET link_status = 'processing' WHERE session_id = $1", [
      job.session_id,
    ]);

    // 2. Normalize timestamps for raw_data_objects if clock offset is available
    if (clockOffsetInfo) {
      await normalizeRawObjectTimestamps(dbClient, session.user_id, clockOffsetInfo);
    } else {
      console.warn(
        `[Job] No clock_offset_info for session ${job.session_id}. Skipping timestamp normalization.`,
      );
    }

    // 3. Link raw_data_objects to the session
    await linkRawObjectsToSession(dbClient, session);

    // 4. Link media files (images, audio) to the experiment
    await linkMediaToExperiment(dbClient, session);

    // 5. Update session status to 'completed'
    await dbClient.query("UPDATE sessions SET link_status = 'completed' WHERE session_id = $1", [
      job.session_id,
    ]);

    // 6. Enqueue job for the next service in the pipeline: EventCorrector
    const eventCorrectorJob = { session_id: job.session_id };
    getAmqpChannel().sendToQueue(
      config.EVENT_CORRECTION_QUEUE,
      Buffer.from(JSON.stringify(eventCorrectorJob)),
      { persistent: true },
    );
    console.log(`[Job] Enqueued job for EventCorrector for session: ${job.session_id}`);

    // 7. Commit the transaction
    await dbClient.query('COMMIT');
    console.log(`[Job] ✅ Success: Finished linking for session ${job.session_id}`);
  } catch (error) {
    await dbClient.query('ROLLBACK');
    console.error(`[Job] ❌ Failure: Rolled back transaction for session ${job.session_id}`, error);

    // Update status to 'failed' in a separate query outside the rolled-back transaction
    await dbPool.query("UPDATE sessions SET link_status = 'failed' WHERE session_id = $1", [
      job.session_id,
    ]);

    // Re-throw the error to ensure the message is NACK'd by the queue consumer
    throw error;
  } finally {
    dbClient.release();
  }
}

/**
 * Finds raw data objects related to the user and updates their UTC timestamps.
 */
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

/**
 * Links normalized raw_data_objects to the session via the junction table.
 */
async function linkRawObjectsToSession(dbClient: PoolClient, session: any) {
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
    `[Link] Linked ${result.rowCount} raw data objects to session ${session.session_id}.`,
  );
}

/**
 * Updates media files recorded during the session with the experiment_id.
 */
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
