import { PoolClient } from 'pg';
import { dbPool } from '../../infrastructure/db';
import type { DataLinkerJobPayload } from '../../app/schemas/job';
import { getAmqpChannel } from '../../infrastructure/queue';
import { config } from '../../config/env';

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

    console.log(
      `[Job Details] Processing session: ${session.session_id}, User: ${session.user_id}`,
    );
    if (session.start_time && session.end_time) {
      console.log(
        `[Job Details] Session Time Range (UTC): ${new Date(
          session.start_time,
        ).toISOString()} to ${new Date(session.end_time).toISOString()}`,
      );
    }

    await dbClient.query("UPDATE sessions SET link_status = 'processing' WHERE session_id = $1", [
      job.session_id,
    ]);

    await linkRawDataToSession(dbClient, session);

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

/**
 * Finds raw data objects within the session's timeframe, updates their timestamps,
 * and links them to the session.
 * @param dbClient - The active database client.
 * @param session - The session object from the database.
 */
async function linkRawDataToSession(dbClient: PoolClient, session: any) {
  const { session_id, user_id, start_time, end_time } = session;

  if (!start_time || !end_time) {
    console.warn(
      `[Link] Session ${session_id} is missing start or end time. Skipping raw data linking.`,
    );
    return;
  }

  const startTimeMs = new Date(start_time).getTime();
  const endTimeMs = new Date(end_time).getTime();
  const windowPaddingMs = 2_000;
  const rangeStart = startTimeMs - windowPaddingMs;
  const rangeEnd = endTimeMs + windowPaddingMs;

  const findObjectsQuery = `
    SELECT object_id, timestamp_start_ms, timestamp_end_ms
    FROM raw_data_objects
    WHERE
      user_id = $1
      AND (session_id IS NULL OR session_id = $4)
      AND timestamp_end_ms >= $2
      AND timestamp_start_ms <= $3
    ORDER BY timestamp_start_ms ASC;
  `;

  const candidates = await dbClient.query(findObjectsQuery, [
    user_id,
    rangeStart,
    rangeEnd,
    session_id,
  ]);

  if (candidates.rowCount === 0) {
    console.log(`[Link] No new raw data objects found for session ${session_id}.`);
    return;
  }

  console.log(
    `[Link] Found ${candidates.rowCount} candidate objects to link for session ${session_id}.`,
  );

  const objectIds = candidates.rows.map((row) => row.object_id);
  if (objectIds.length === 0) {
    console.log(`[Link] Candidate objects missing identifiers for session ${session_id}.`);
    return;
  }

  const toIsoString = (value: unknown, objectId: string, label: string): string => {
    const numericValue =
      typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : Number(value);
    if (!Number.isFinite(numericValue)) {
      throw new Error(
        `[Link] Invalid ${label} value for object ${objectId} (received ${value}).`,
      );
    }
    return new Date(numericValue).toISOString();
  };

  const startTimeIsoValues = candidates.rows.map((row) =>
    toIsoString(row.timestamp_start_ms, row.object_id, 'timestamp_start_ms'),
  );
  const endTimeIsoValues = candidates.rows.map((row) =>
    toIsoString(row.timestamp_end_ms, row.object_id, 'timestamp_end_ms'),
  );

  await dbClient.query(
    `
      UPDATE raw_data_objects AS rdo
      SET
        start_time = data.start_time::timestamptz,
        end_time = data.end_time::timestamptz,
        session_id = $1
      FROM UNNEST($2::text[], $3::text[], $4::text[]) AS data(object_id, start_time, end_time)
      WHERE rdo.object_id = data.object_id;
    `,
    [session_id, objectIds, startTimeIsoValues, endTimeIsoValues],
  );

  await dbClient.query(
    `
      INSERT INTO session_object_links (session_id, object_id)
      SELECT $1, object_id
      FROM UNNEST($2::text[]) AS data(object_id)
      ON CONFLICT (session_id, object_id) DO NOTHING;
    `,
    [session_id, objectIds],
  );

  console.log(
    `[Link] Successfully linked ${objectIds.length} raw data objects for session ${session_id}.`,
  );
}

async function linkMediaToExperiment(dbClient: PoolClient, session: any) {
  if (!session.experiment_id) {
    console.log(
      `[Link] Session ${session.session_id} is not associated with an experiment. Skipping media linkage.`,
    );
    return;
  }
  const imageUpdateRes = await dbClient.query(
    `UPDATE images SET experiment_id = $1 WHERE session_id = $2 AND experiment_id IS NULL`,
    [session.experiment_id, session.session_id],
  );
  const imageRowCount = imageUpdateRes.rowCount ?? 0;
  if (imageRowCount > 0) {
    console.log(`[Link] Linked ${imageRowCount} images to experiment ${session.experiment_id}.`);
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
