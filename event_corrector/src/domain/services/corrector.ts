import { PoolClient } from 'pg';
import { objectStorageClient } from '../../infrastructure/objectStorage';
import { config } from '../../config/env';
import { init as zstdInit } from '@bokuweb/zstd-wasm';
import type { EventCorrectorJobPayload } from '../../app/schemas/job';
import { dbPool } from '../../infrastructure/db';
import { parsePayloadsAndExtractTriggerTimestampsUs } from './trigger_timestamps';

const zstdPromise = zstdInit().then(() => {
  console.log('✅ [ZSTD] WASM module initialized.');
});

const MAX_ALIGNMENT_ERROR_US = 500_000n; // 0.5 seconds tolerance for trigger alignment

const bigintAbs = (value: bigint): bigint => (value < 0n ? -value : value);

/**
 * オブジェクトストレージから全ての生データオブジェクトを個別にダウンロードし、それぞれを伸長したBufferの配列として返す
 */
async function downloadAndDecompressObjects(objectIds: string[]): Promise<Buffer[]> {
  const decompressedBuffers: Buffer[] = [];
  for (const objectId of objectIds) {
    const stream = await objectStorageClient.getObject(
      config.OBJECT_STORAGE_RAW_DATA_BUCKET,
      objectId,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const rawBuffer = Buffer.concat(chunks);
    if (rawBuffer.length === 0) {
      console.warn(`[Corrector] Skipped empty object: ${objectId}`);
      continue;
    }

    decompressedBuffers.push(rawBuffer);
  }
  return decompressedBuffers;
}

async function processCorrectionJob(
  client: PoolClient,
  job: EventCorrectorJobPayload,
): Promise<void> {
  const { session_id } = job;
  await client.query(
    `UPDATE sessions SET event_correction_status = 'processing' WHERE session_id = $1`,
    [session_id],
  );

  const eventsResult = await client.query(
    `SELECT event_id, onset FROM session_events WHERE session_id = $1 ORDER BY onset ASC`,
    [session_id],
  );

  const eventCount = eventsResult.rowCount ?? 0;
  if (eventCount === 0) {
    console.log(
      `[Corrector] No events to correct for session ${session_id}. Marking as completed.`,
    );
    await client.query(
      `UPDATE sessions SET event_correction_status = 'completed' WHERE session_id = $1`,
      [session_id],
    );
    return;
  }

  const objectsResult = await client.query(
    `SELECT t1.object_id, t2.timestamp_start_ms, t2.sampling_rate FROM session_object_links t1 JOIN raw_data_objects t2 ON t1.object_id = t2.object_id WHERE t1.session_id = $1 ORDER BY t2.timestamp_start_ms ASC`,
    [session_id],
  );

  if ((objectsResult.rowCount ?? 0) === 0) {
    console.warn(
      `[Corrector] No raw data linked to session ${session_id}. Cannot correct. Marking as completed.`,
    );
    await client.query(
      `UPDATE sessions SET event_correction_status = 'completed' WHERE session_id = $1`,
      [session_id],
    );
    return;
  }

  const objectIds = objectsResult.rows.map((r) => r.object_id);
  const decompressedBuffers = await downloadAndDecompressObjects(objectIds);

  const payloads = objectsResult.rows
    .map((row, i) => ({
      buffer: decompressedBuffers[i],
      startTimeMs: Number(row.timestamp_start_ms),
      samplingRate: Number(row.sampling_rate),
    }))
    .filter((p) => p.buffer);

  const allTriggersUs = parsePayloadsAndExtractTriggerTimestampsUs(payloads);

  console.log(
    `[Corrector] Found ${eventCount} events and detected ${allTriggersUs.length} triggers for session ${session_id}.`,
  );

  if (allTriggersUs.length === 0) {
    console.warn(
      `[Corrector] No triggers were found in the raw data for session ${session_id}. Events cannot be corrected.`,
    );
    await client.query(
      `UPDATE sessions SET event_correction_status = 'completed' WHERE session_id = $1`,
      [session_id],
    );
    return;
  }

  if (eventCount !== allTriggersUs.length) {
    console.warn(
      `[Corrector] Mismatch: Event count (${eventCount}) does not match detected trigger count (${allTriggersUs.length}) for session ${session_id}. Proceeding with best-effort matching.`,
    );
  }

  let sessionStartTimeUs: bigint | null = null;
  try {
    const sessionRow = await client.query<{ start_time: Date | string | null }>(
      `SELECT start_time FROM sessions WHERE session_id = $1`,
      [session_id],
    );
    const startTimeValue = sessionRow.rows[0]?.start_time ?? null;
    if (startTimeValue) {
      const startTimeMs =
        startTimeValue instanceof Date
          ? startTimeValue.getTime()
          : new Date(startTimeValue).getTime();
      if (!Number.isNaN(startTimeMs)) {
        sessionStartTimeUs = BigInt(Math.round(startTimeMs)) * 1000n;
      }
    }
  } catch (lookupError) {
    console.warn(
      `[Corrector] Failed to resolve start_time for session ${session_id}. Falling back to sequential trigger matching.`,
      lookupError,
    );
  }

  const eventsToUpdate = Math.min(eventCount, allTriggersUs.length);
  const expectedEventTimesUs =
    sessionStartTimeUs !== null
      ? eventsResult.rows.slice(0, eventsToUpdate).map((row) => {
          const onsetSeconds = Number(row.onset ?? 0);
          if (!Number.isFinite(onsetSeconds)) {
            console.warn(
              `[Corrector] Non-finite onset for event ${row.event_id} in session ${session_id}. Using sequential trigger alignment.`,
            );
            return null;
          }
          const onsetOffsetUs = BigInt(Math.round(onsetSeconds * 1_000_000));
          return sessionStartTimeUs! + onsetOffsetUs;
        })
      : null;

  let triggerIndex = 0;
  let lastAppliedTimestampUs: bigint | null = null;

  for (let i = 0; i < eventsToUpdate; i++) {
    const eventId = eventsResult.rows[i].event_id;
    if (triggerIndex >= allTriggersUs.length) {
      break;
    }

    let correctedTimestampUs = allTriggersUs[triggerIndex];
    const targetTimestampUs = expectedEventTimesUs?.[i] ?? null;

    if (targetTimestampUs !== null) {
      const remainingEvents = eventsToUpdate - i;
      const maxSearchIndex = Math.max(triggerIndex, allTriggersUs.length - remainingEvents);

      let bestIndex = triggerIndex;
      let bestDiff = bigintAbs(allTriggersUs[bestIndex] - targetTimestampUs);

      for (let cursor = triggerIndex + 1; cursor <= maxSearchIndex; cursor++) {
        const diff = bigintAbs(allTriggersUs[cursor] - targetTimestampUs);
        if (diff <= bestDiff) {
          bestIndex = cursor;
          bestDiff = diff;
        } else {
          break;
        }
      }

      correctedTimestampUs = allTriggersUs[bestIndex];
      if (bestDiff > MAX_ALIGNMENT_ERROR_US) {
        console.warn(
          `[Corrector] Trigger alignment difference of ${
            Number(bestDiff) / 1_000_000
          }s for event ${eventId} in session ${session_id}.`,
        );
      }
      triggerIndex = bestIndex;
    }

    triggerIndex = Math.min(triggerIndex + 1, allTriggersUs.length);

    if (lastAppliedTimestampUs !== null && correctedTimestampUs <= lastAppliedTimestampUs) {
      correctedTimestampUs = lastAppliedTimestampUs + 1n;
      console.warn(
        `[Corrector] Adjusted non-increasing timestamp for event ${eventId} in session ${session_id}.`,
      );
    }

    await client.query(`UPDATE session_events SET onset_corrected_us = $1 WHERE event_id = $2`, [
      correctedTimestampUs.toString(),
      eventId,
    ]);
    lastAppliedTimestampUs = correctedTimestampUs;
  }

  console.log(
    `[Corrector] Successfully updated ${eventsToUpdate} events for session ${session_id}.`,
  );
  await client.query(
    `UPDATE sessions SET event_correction_status = 'completed' WHERE session_id = $1`,
    [session_id],
  );
}

export async function handleEventCorrectorJob(job: EventCorrectorJobPayload): Promise<void> {
  await zstdPromise;
  console.log(`[Job] Starting: Correcting events for session ${job.session_id}`);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await processCorrectionJob(client, job);
    await client.query('COMMIT');
    console.log(`[Job] ✅ Success: Finished processing events for session ${job.session_id}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[Job] ❌ Failure: Rolled back transaction for session ${job.session_id}`, error);
    await client.query(
      `UPDATE sessions SET event_correction_status = 'failed' WHERE session_id = $1`,
      [job.session_id],
    );
    throw error;
  } finally {
    client.release();
  }
}
