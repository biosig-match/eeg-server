import { PoolClient } from 'pg';
import { minioClient } from '../../infrastructure/minio';
import { config } from '../../config/env';
import { init as zstdInit, decompress as zstdDecompressRaw } from '@bokuweb/zstd-wasm';
import type { EventCorrectorJobPayload } from '../../app/schemas/job';
import { dbPool } from '../../infrastructure/db';

const zstdPromise = zstdInit().then(() => {
  console.log('✅ [ZSTD] WASM module initialized.');
});

const zstdDecompress: (buf: Uint8Array) => Uint8Array = zstdDecompressRaw as any;
const ELECTRODE_TYPE_TRIG = 3;

/**
 * MinIOから全ての生データオブジェクトを個別にダウンロードし、それぞれを伸長したBufferの配列として返す
 */
async function downloadAndDecompressObjects(objectIds: string[]): Promise<Buffer[]> {
  const decompressedBuffers: Buffer[] = [];
  for (const objectId of objectIds) {
    const stream = await minioClient.getObject(config.MINIO_RAW_DATA_BUCKET, objectId);
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

function parsePayloadsAndExtractTriggerTimestamps(
  payloads: { buffer: Buffer; startTimeMs: number; samplingRate: number }[],
): bigint[] {
  const allTriggerTimestamps: bigint[] = [];

  for (const payload of payloads) {
    const { buffer, startTimeMs, samplingRate } = payload;
    if (samplingRate <= 0) {
      console.error('[Corrector] Invalid sampling rate, skipping payload.', samplingRate);
      continue;
    }
    const msPerSample = 1000 / samplingRate;

    try {
      if (buffer.length < 4) continue; // version(1) + num_channels(1) + reserved(2)

      let offset = 0;
      const version = buffer.readUInt8(offset);
      offset += 1;
      if (version !== 0x04) {
        console.warn(`[Corrector] Unsupported payload version ${version}, skipping.`);
        continue;
      }
      const num_channels = buffer.readUInt8(offset);
      offset += 1;
      offset += 2; // Skip reserved bytes

      let triggerChannelIndex = -1;
      for (let i = 0; i < num_channels; i++) {
        offset += 8; // Skip name
        const type = buffer.readUInt8(offset);
        offset += 1;
        offset += 1; // Skip reserved
        if (type === ELECTRODE_TYPE_TRIG) {
          triggerChannelIndex = i;
        }
      }

      if (triggerChannelIndex === -1) {
        continue;
      }

      const headerSize = offset;
      const sampleSize = num_channels * 2 + 6 + 6 + num_channels;
      if (sampleSize === 0) continue;

      const samplesBuffer = buffer.slice(headerSize);
      const numSamples = Math.floor(samplesBuffer.length / sampleSize);

      let previousTriggerValue = 0;

      for (let i = 0; i < numSamples; i++) {
        const sampleOffset = i * sampleSize;
        const signalsOffset = sampleOffset + triggerChannelIndex * 2;
        const currentTriggerValue = samplesBuffer.readInt16LE(signalsOffset);

        if (previousTriggerValue === 0 && currentTriggerValue !== 0) {
          // タイムスタンプをマイクロ秒単位のBigIntで計算する
          const timestampMs = BigInt(startTimeMs) + BigInt(Math.round(i * msPerSample));
          allTriggerTimestamps.push(timestampMs);
        }
        previousTriggerValue = currentTriggerValue;
      }
    } catch (error) {
      console.error('[Corrector] Error parsing a binary payload, skipping it.', error);
    }
  }

  allTriggerTimestamps.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return allTriggerTimestamps;
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

  const allTriggers = parsePayloadsAndExtractTriggerTimestamps(payloads);

  console.log(
    `[Corrector] Found ${eventCount} events and detected ${allTriggers.length} triggers for session ${session_id}.`,
  );

  if (allTriggers.length === 0) {
    console.warn(
      `[Corrector] No triggers were found in the raw data for session ${session_id}. Events cannot be corrected.`,
    );
    await client.query(
      `UPDATE sessions SET event_correction_status = 'completed' WHERE session_id = $1`,
      [session_id],
    );
    return;
  }

  if (eventCount !== allTriggers.length) {
    console.warn(
      `[Corrector] Mismatch: Event count (${eventCount}) does not match detected trigger count (${allTriggers.length}) for session ${session_id}. Proceeding with best-effort matching.`,
    );
  }

  const eventsToUpdate = Math.min(eventCount, allTriggers.length);
  for (let i = 0; i < eventsToUpdate; i++) {
    const eventId = eventsResult.rows[i].event_id;
    const correctedTimestampMs = allTriggers[i];
    const correctedTimestampUs = correctedTimestampMs * 1000n;
    await client.query(`UPDATE session_events SET onset_corrected_us = $1 WHERE event_id = $2`, [
      correctedTimestampUs.toString(),
      eventId,
    ]);
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

