import amqp, { Channel, Connection, ConsumeMessage } from 'amqplib';
import { Client as MinioClient } from 'minio';
import { Pool } from 'pg';
import { init as zstdInit, decompress as zstdDecompress } from '@bokuweb/zstd-wasm';
import { v4 as uuidv4 } from 'uuid';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://admin:password@db:5432/eeg_data';
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'minio';
const MINIO_PORT = parseInt(process.env.MINIO_PORT || '9000', 10);
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === 'true';
const MINIO_RAW_DATA_BUCKET = process.env.MINIO_RAW_DATA_BUCKET || 'raw-data';

const RAW_DATA_EXCHANGE = 'raw_data_exchange';
const PROCESSING_QUEUE = 'processing_queue';

// --- データ構造の定数 ---
const HEADER_SIZE = 18; // sizeof(PacketHeader)
const POINT_SIZE = 53; // sizeof(SensorData)

// --- グローバルクライアントと状態 ---
let amqpConnection: Connection | null = null;
let amqpChannel: Channel | null = null;
const pgPool = new Pool({ connectionString: DATABASE_URL });
const minioClient = new MinioClient({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
});

/**
 * 伸長されたデータパケットからメタデータを解析するロジック
 */
function extractMetadataFromPacket(decompressedData: Buffer): {
  deviceId: string;
  startTime: number; // 32-bit integer
  endTime: number; // 32-bit integer
} {
  if (decompressedData.length < HEADER_SIZE + POINT_SIZE) {
    throw new Error('データがヘッダーと最低1つのデータポイントを含むには短すぎます。');
  }

  // 1. deviceIdの抽出 (PacketHeaderから)
  const headerBuffer = decompressedData.slice(0, HEADER_SIZE);
  const nullTerminatorIndex = headerBuffer.indexOf(0);
  const deviceId = headerBuffer.toString(
    'ascii',
    0,
    nullTerminatorIndex !== -1 ? nullTerminatorIndex : undefined,
  );

  // 2. タイムスタンプの抽出 (SensorDataから)
  const pointsBuffer = decompressedData.slice(HEADER_SIZE);
  const numPoints = Math.floor(pointsBuffer.length / POINT_SIZE);

  if (numPoints <= 0) {
    throw new Error('パケットに有効なデータポイントが見つかりません。');
  }

  const timestampOffsetInPoint = 49;

  const startTime = pointsBuffer.readUInt32LE(timestampOffsetInPoint);

  const lastPointOffset = (numPoints - 1) * POINT_SIZE;
  const endTime = pointsBuffer.readUInt32LE(lastPointOffset + timestampOffsetInPoint);

  return { deviceId, startTime, endTime };
}

/**
 * メインのメッセージ処理ロジック
 */
async function processMessage(msg: ConsumeMessage | null) {
  if (!msg) return;

  try {
    const compressedPayload = msg.content;
    const userId = msg.properties?.headers?.user_id?.toString();

    if (!userId) {
      console.warn('user_idヘッダーなしでメッセージを受信しました。ACKを送信して破棄します。');
      amqpChannel?.ack(msg);
      return;
    }

    // 伸長処理
    const decompressedData = zstdDecompress(compressedPayload);

    const { deviceId, startTime, endTime } = extractMetadataFromPacket(
      Buffer.from(decompressedData),
    );

    // MinIO用のオブジェクトIDを生成
    const objectId = `raw/${userId}/start_tick=${startTime}/end_tick=${endTime}_${uuidv4()}.zst`;

    // 1. 元の圧縮データをMinIOにアップロード
    const metaData = {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'zstd',
      'X-User-Id': userId,
      'X-Device-Id': deviceId,
    };
    await minioClient.putObject(
      MINIO_RAW_DATA_BUCKET,
      objectId,
      compressedPayload,
      compressedPayload.length,
      metaData,
    );
    console.log(`[MinIO] アップロード成功: ${objectId}`);

    // 2. メタデータをPostgreSQLに挿入
    const query = `
      INSERT INTO raw_data_objects (object_id, user_id, device_id, start_time_device, end_time_device)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (object_id) DO NOTHING;
    `;
    await pgPool.query(query, [objectId, userId, deviceId, startTime, endTime]);
    console.log(`[PostgreSQL] メタデータ挿入成功: ${objectId}`);

    // 3. メッセージのACKを送信
    amqpChannel?.ack(msg);
  } catch (error: any) {
    console.error('❌ メッセージ処理中にエラーが発生しました:', error.message);
    amqpChannel?.nack(msg, false, false);
  }
}

async function startConsumer() {
  console.log('[RabbitMQ] 接続中...');
  amqpConnection = await amqp.connect(RABBITMQ_URL);
  amqpChannel = await amqpConnection.createChannel();
  console.log('✅ [RabbitMQ] 接続し、チャネルを作成しました。');

  await amqpChannel.assertExchange(RAW_DATA_EXCHANGE, 'fanout', { durable: true });
  await amqpChannel.assertQueue(PROCESSING_QUEUE, { durable: true });
  await amqpChannel.bindQueue(PROCESSING_QUEUE, RAW_DATA_EXCHANGE, '');

  amqpChannel.prefetch(1);

  console.log(`🚀 プロセッサーサービスがキューでメッセージを待機中: "${PROCESSING_QUEUE}"`);
  amqpChannel.consume(PROCESSING_QUEUE, processMessage);
}

async function ensureMinioBucket() {
  const bucketExists = await minioClient.bucketExists(MINIO_RAW_DATA_BUCKET);
  if (!bucketExists) {
    console.log(`[MinIO] バケット "${MINIO_RAW_DATA_BUCKET}" が存在しません。作成します...`);
    await minioClient.makeBucket(MINIO_RAW_DATA_BUCKET);
    console.log(`✅ [MinIO] バケット "${MINIO_RAW_DATA_BUCKET}" を作成しました。`);
  } else {
    console.log(`✅ [MinIO] バケット "${MINIO_RAW_DATA_BUCKET}" はすでに存在します。`);
  }
}

async function main() {
  try {
    await zstdInit();
    console.log('✅ [ZSTD] WASMモジュールを初期化しました。');

    await ensureMinioBucket();
    await startConsumer();
  } catch (error) {
    console.error('❌ プロセッサーサービスの起動に失敗しました:', error);
    process.exit(1);
  }
}

main();
