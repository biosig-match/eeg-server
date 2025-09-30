import { PoolClient } from 'pg';
import { minioClient } from '@/lib/minio';
import { config } from '@/lib/config';
import { init as zstdInit, decompress as zstdDecompress } from '@bokuweb/zstd-wasm';
import type { EventCorrectorJobPayload } from '@/schemas/job';
import { dbPool } from '@/lib/db';

const zstdPromise = zstdInit().then(() => {
  console.log('✅ [ZSTD] WASM module initialized.');
});

const HEADER_SIZE = 18;
const POINT_SIZE = 53;
const TRIGGER_OFFSET = 48;
const TIMESTAMP_US_OFFSET = 49;

/**
 * MinIOから全ての生データオブジェクトを個別にダウンロードし、それぞれを伸長したBufferの配列として返す
 */
async function downloadAndDecompressObjects(objectIds: string[]): Promise<Buffer[]> {
  const decompressedBuffers: Buffer[] = [];
  for (const objectId of objectIds) {
    const stream = await minioClient.getObject(config.MINIO_RAW_DATA_BUCKET, objectId);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const compressedBuffer = Buffer.concat(chunks);
    if (compressedBuffer.length > 0) {
      const decompressed = zstdDecompress(compressedBuffer);
      decompressedBuffers.push(Buffer.from(decompressed));
      console.log(`[Corrector] Decompressed object ${objectId}: ${compressedBuffer.length} bytes -> ${decompressed.length} bytes`);
    } else {
      console.warn(`[Corrector] Skipped empty object: ${objectId}`);
    }
  }
  return decompressedBuffers;
}

/**
 * 伸長された単一の生データパケットからトリガのタイムスタンプを抽出する
 */
function extractTriggerTimestamps(decompressedData: Buffer): bigint[] {
  const triggerTimestamps: bigint[] = [];
  if (decompressedData.length < HEADER_SIZE + POINT_SIZE) {
    return []; // データが不十分
  }

  const pointsBuffer = decompressedData.slice(HEADER_SIZE);
  const numPoints = Math.floor(pointsBuffer.length / POINT_SIZE);

  for (let i = 0; i < numPoints; i++) {
    const pointOffset = i * POINT_SIZE;
    const point = pointsBuffer.slice(pointOffset, pointOffset + POINT_SIZE);
    if (point.readUInt8(TRIGGER_OFFSET) === 1) {
      const timestamp = BigInt(point.readUInt32LE(TIMESTAMP_US_OFFSET));
      triggerTimestamps.push(timestamp);
    }
  }
  return triggerTimestamps;
}

async function processCorrectionJob(client: PoolClient, job: EventCorrectorJobPayload): Promise<void> {
  const { session_id } = job;
  await client.query(`UPDATE sessions SET event_correction_status = 'processing' WHERE session_id = $1`, [session_id]);

  const sessionResult = await client.query('SELECT * FROM sessions WHERE session_id = $1', [session_id]);
  if (sessionResult.rowCount === 0) throw new Error(`Session ${session_id} not found.`);
  const session = sessionResult.rows[0];

  const eventsResult = await client.query(`SELECT event_id, onset FROM session_events WHERE session_id = $1 ORDER BY onset ASC`, [session_id]);
  const objectsResult = await client.query(
    `SELECT t1.object_id FROM session_object_links t1
     JOIN raw_data_objects t2 ON t1.object_id = t2.object_id
     WHERE t1.session_id = $1 ORDER BY t2.start_time_device ASC`,
    [session_id],
  );

  if (eventsResult.rowCount === 0) {
    console.log(`[Corrector] No events for session ${session_id}. Marking as completed.`);
    await client.query(`UPDATE sessions SET event_correction_status = 'completed' WHERE session_id = $1`, [session_id]);
    return;
  }

  const objectIds = objectsResult.rows.map((r) => r.object_id);
  if (objectIds.length === 0) {
    console.warn(`[Corrector] No raw data linked to session ${session_id}. Cannot correct. Marking as completed.`);
    await client.query(`UPDATE sessions SET event_correction_status = 'completed' WHERE session_id = $1`, [session_id]);
    return;
  }

  if (!session.clock_offset_info) {
    throw new Error(`Cannot correct events for session ${session_id} without clock_offset_info.`);
  }
  const offsetMs = session.clock_offset_info.offset_ms_avg;
  
  const sessionStartDeviceUs = BigInt(Math.round(new Date(session.start_time).getTime() - offsetMs)) * 1000n;
  const sessionEndDeviceUs = BigInt(Math.round(new Date(session.end_time).getTime() - offsetMs)) * 1000n;
  
  const MASK_32BIT = 0xffffffffn;
  const sessionStart32bit = sessionStartDeviceUs & MASK_32BIT;
  const sessionEnd32bit = sessionEndDeviceUs & MASK_32BIT;
  
  console.log(`[Corrector] Session device time range (32-bit us): ${sessionStart32bit} to ${sessionEnd32bit}`);

  // ### <<< 修正点 >>> ###
  // 複数の伸長済みバッファを個別に処理し、結果を結合する
  const decompressedBuffers = await downloadAndDecompressObjects(objectIds);
  const allTriggers = decompressedBuffers.flatMap(buffer => extractTriggerTimestamps(buffer));
  allTriggers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // 念のためソート

  const relevantTriggers = allTriggers.filter(ts => {
    if (sessionStart32bit <= sessionEnd32bit) {
      return ts >= sessionStart32bit && ts <= sessionEnd32bit;
    } else {
      return ts >= sessionStart32bit || ts <= sessionEnd32bit;
    }
  });
  
  console.log(`[Corrector] Found ${eventsResult.rowCount} events, ${allTriggers.length} total triggers, and ${relevantTriggers.length} relevant triggers for session ${session_id}.`);

  if (eventsResult.rowCount !== relevantTriggers.length) {
    throw new Error(`Event count (${eventsResult.rowCount}) does not match relevant trigger count (${relevantTriggers.length}) for session ${session_id}.`);
  }

  for (let i = 0; i < eventsResult.rowCount; i++) {
    const eventId = eventsResult.rows[i].event_id;
    const correctedTimestamp = relevantTriggers[i];
    await client.query(`UPDATE session_events SET onset_corrected_us = $1 WHERE event_id = $2`, [correctedTimestamp.toString(), eventId]);
  }
  console.log(`[Corrector] Successfully updated ${eventsResult.rowCount} events.`);
  await client.query(`UPDATE sessions SET event_correction_status = 'completed' WHERE session_id = $1`, [session_id]);
}

export async function handleEventCorrectorJob(job: EventCorrectorJobPayload): Promise<void> {
  await zstdPromise;
  console.log(`[Job] Starting: Correcting events for session ${job.session_id}`);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await processCorrectionJob(client, job);
    await client.query('COMMIT');
    console.log(`[Job] ✅ Success: Finished correcting events for session ${job.session_id}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[Job] ❌ Failure: Rolled back transaction for session ${job.session_id}`, error);
    await client.query(`UPDATE sessions SET event_correction_status = 'failed' WHERE session_id = $1`, [job.session_id]);
    throw error;
  } finally {
    client.release();
  }
}

