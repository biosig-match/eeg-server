import { PoolClient } from 'pg';
import { minioClient } from '@/lib/minio';
import { config } from '@/lib/config';
import { init as zstdInit, decompress as zstdDecompress } from '@bokuweb/zstd-wasm';
import type { EventCorrectorJobPayload } from '@/schemas/job';
import { dbPool } from '@/lib/db'; // <- 修正点: dbPoolをインポート

// ZSTD WASMの初期化を一度だけ行う
const zstdPromise = zstdInit().then(() => {
  console.log('✅ [ZSTD] WASM module initialized.');
});

// マイコンのデータ構造に合わせた定数
const HEADER_SIZE = 18; // sizeof(PacketHeader)
const POINT_SIZE = 53; // sizeof(SensorData)
const TRIGGER_OFFSET = 48; // trigger in SensorData struct
const TIMESTAMP_US_OFFSET = 49; // timestamp_us in SensorData struct

/**
 * MinIOから全ての生データオブジェクトをダウンロードし、一つのバッファに結合する
 */
async function downloadAndCombineObjects(objectIds: string[]): Promise<Buffer> {
  const buffers: Buffer[] = [];
  for (const objectId of objectIds) {
    const stream = await minioClient.getObject(config.MINIO_RAW_DATA_BUCKET, objectId);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    buffers.push(Buffer.concat(chunks));
  }
  return Buffer.concat(buffers);
}

/**
 * 結合・伸長された生データからトリガのタイムスタンプを抽出する
 */
function extractTriggerTimestamps(decompressedData: Buffer): bigint[] {
  const triggerTimestamps: bigint[] = [];

  // 各PacketHeaderをスキップしてSensorDataの配列部分のみを処理
  let offset = 0;
  while (offset < decompressedData.length) {
    const payloadStart = offset + HEADER_SIZE;
    const payloadEnd = offset + HEADER_SIZE + POINT_SIZE * (config.SAMPLE_RATE / 2);
    const payload = decompressedData.slice(
      payloadStart,
      Math.min(payloadEnd, decompressedData.length),
    );

    for (let i = 0; i + POINT_SIZE <= payload.length; i += POINT_SIZE) {
      const point = payload.slice(i, i + POINT_SIZE);
      if (point.readUInt8(TRIGGER_OFFSET) === 1) {
        // Read uint32_t for timestamp_us and convert to BigInt
        const timestamp = BigInt(point.readUInt32LE(TIMESTAMP_US_OFFSET));
        triggerTimestamps.push(timestamp);
      }
    }
    offset = payloadEnd;
  }
  return triggerTimestamps;
}

/**
 * 単一のイベント補正ジョブをDBトランザクション内で実行する
 */
async function processCorrectionJob(
  client: PoolClient,
  job: EventCorrectorJobPayload,
): Promise<void> {
  const { session_id } = job;

  await client.query(
    `UPDATE sessions SET event_correction_status = 'processing' WHERE session_id = $1`,
    [session_id],
  );

  // 1. DBからイベントとオブジェクトIDを取得
  const eventsResult = await client.query(
    `SELECT event_id, onset FROM session_events WHERE session_id = $1 ORDER BY onset ASC`,
    [session_id],
  );
  const objectsResult = await client.query(
    `SELECT t1.object_id FROM session_object_links t1
       JOIN raw_data_objects t2 ON t1.object_id = t2.object_id
       WHERE t1.session_id = $1 ORDER BY t2.start_time_device ASC`,
    [session_id],
  );

  if (eventsResult.rowCount === 0) {
    console.log(`[Corrector] No events found for session ${session_id}. Marking as completed.`);
    await client.query(
      `UPDATE sessions SET event_correction_status = 'completed' WHERE session_id = $1`,
      [session_id],
    );
    return;
  }

  const objectIds = objectsResult.rows.map((r) => r.object_id);
  if (objectIds.length === 0) {
    // ★★★ 堅牢性の向上 ★★★
    // リンクされたオブジェクトがない場合、エラーにせず警告を出力して正常終了とする
    console.warn(
      `[Corrector] No raw data objects linked to session ${session_id}. Cannot perform correction. Marking as completed without correction.`,
    );
    await client.query(
      `UPDATE sessions SET event_correction_status = 'completed' WHERE session_id = $1`,
      [session_id],
    );
    return;
  }

  // 2. MinIOからデータをダウンロード・結合
  const combinedBuffer = await downloadAndCombineObjects(objectIds);

  // 3. データを伸長し、トリガを抽出
  // <- 修正点: zstdDecompressの結果をBuffer.from()でラップする
  const decompressedData = Buffer.from(zstdDecompress(combinedBuffer));
  const triggerTimestamps = extractTriggerTimestamps(decompressedData);

  console.log(
    `[Corrector] Found ${eventsResult.rowCount} events and ${triggerTimestamps.length} triggers for session ${session_id}.`,
  );

  // 4. シーケンスマッチング（今回は単純な数の一致を確認）
  if (eventsResult.rowCount !== triggerTimestamps.length) {
    throw new Error(
      `Event count (${eventsResult.rowCount}) does not match trigger count (${triggerTimestamps.length}) for session ${session_id}.`,
    );
  }

  // 5. DBを更新
  for (let i = 0; i < eventsResult.rowCount; i++) {
    const eventId = eventsResult.rows[i].event_id;
    const correctedTimestamp = triggerTimestamps[i];
    await client.query(`UPDATE session_events SET onset_corrected_us = $1 WHERE event_id = $2`, [
      correctedTimestamp.toString(),
      eventId,
    ]);
  }
  console.log(
    `[Corrector] Successfully updated ${eventsResult.rowCount} events with corrected timestamps.`,
  );

  await client.query(
    `UPDATE sessions SET event_correction_status = 'completed' WHERE session_id = $1`,
    [session_id],
  );
}

/**
 * ジョブのライフサイクル管理（DBクライアント、トランザクション、エラーハンドリング）
 */
export async function handleEventCorrectorJob(job: EventCorrectorJobPayload): Promise<void> {
  await zstdPromise; // WASMの初期化を待つ
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
    await client.query(
      `UPDATE sessions SET event_correction_status = 'failed' WHERE session_id = $1`,
      [job.session_id],
    );
    throw error;
  } finally {
    client.release();
  }
}
