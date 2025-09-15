import amqp, { Channel, Connection } from 'amqplib';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import multer from 'multer';
import { AddressInfo } from 'net';

// --- 環境変数と設定 (Constants) ---
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq';
const PORT = process.env.PORT || 3000;

// ドキュメントで定義されたExchangeとQueueの名前
const RAW_DATA_EXCHANGE = 'raw_data_exchange';
const MEDIA_PROCESSING_QUEUE = 'media_processing_queue';

// --- Expressアプリケーションのセットアップ (Application Setup) ---
const app = express();
const server = http.createServer(app);
const upload = multer({ storage: multer.memoryStorage() });

// JSONボディパーサーを有効化
app.use(express.json({ limit: '10mb' })); // センサーデータ用に上限を緩和

let amqpConnection: Connection | null = null;
let amqpChannel: Channel | null = null;

// --- RabbitMQ接続・再接続ロジック (RabbitMQ Connection Logic) ---
async function connectRabbitMQ() {
  let attempts = 0;
  while (true) {
    try {
      console.log(`[RabbitMQ] Connecting... (Attempt: ${attempts + 1})`);
      const connection = await amqp.connect(RABBITMQ_URL);

      connection.on('close', () => {
        console.error('❌ [RabbitMQ] Connection closed. Reconnecting in 5 seconds...');
        amqpConnection = null;
        amqpChannel = null;
        setTimeout(connectRabbitMQ, 5000);
      });
      connection.on('error', (err) => {
        console.error('❌ [RabbitMQ] Connection error:', err.message);
      });

      console.log('✅ [RabbitMQ] Connection successful.');
      amqpConnection = connection;
      await setupChannelAndTopology();
      break;
    } catch (err: any) {
      console.error(`❌ [RabbitMQ] Connection failed: ${err.message}`);
      attempts++;
      const delay = Math.min(30000, 2 ** attempts * 1000);
      console.log(`[RabbitMQ] Retrying in ${delay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function setupChannelAndTopology() {
  if (!amqpConnection) {
    console.warn('[RabbitMQ] Channel setup skipped: no connection.');
    return;
  }
  try {
    amqpChannel = await amqpConnection.createChannel();
    console.log('✅ [RabbitMQ] Channel created.');

    // ★★★ ドキュメントに基づき、ExchangeとQueueを準備 ★★★
    // センサーデータ用のFanout Exchange
    await amqpChannel.assertExchange(RAW_DATA_EXCHANGE, 'fanout', { durable: true });
    console.log(`✅ [RabbitMQ] Fanout Exchange "${RAW_DATA_EXCHANGE}" is ready.`);

    // メディアデータ用のDirect Queue
    await amqpChannel.assertQueue(MEDIA_PROCESSING_QUEUE, { durable: true });
    console.log(`✅ [RabbitMQ] Queue "${MEDIA_PROCESSING_QUEUE}" is ready.`);
  } catch (err: any) {
    console.error('❌ [RabbitMQ] Channel setup failed:', err.message);
    amqpChannel = null;
  }
}

// --- ミドルウェア (Middleware) ---
// RabbitMQチャネルが利用可能かチェックするミドルウェア
const checkRabbitMQ = (req: Request, res: Response, next: NextFunction) => {
  if (!amqpChannel) {
    return res.status(503).json({
      error: 'Service Unavailable',
      message: 'The message broker is not available at the moment. Please try again later.',
    });
  }
  next();
};

// --- HTTP APIエンドポイント (HTTP API Endpoints) ---

/**
 * @route GET /api/v1/health
 * @description サービスの稼働状態とRabbitMQへの接続状態を返す
 */
app.get('/api/v1/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'collector-service',
    rabbitmq_connected: !!amqpChannel,
    timestamp: new Date().toISOString(),
  });
});

/**
 * @route POST /api/v1/data
 * @description センサーデータ(圧縮バイナリ)を受信し、raw_data_exchangeへ転送する
 * @input JSON { user_id: string, payload_base64: string }
 */
app.post('/api/v1/data', checkRabbitMQ, (req: Request, res: Response) => {
  const { user_id, payload_base64 } = req.body;

  // バリデーション
  if (typeof user_id !== 'string' || typeof payload_base64 !== 'string') {
    return res
      .status(400)
      .json({
        error: 'Bad Request',
        message: '`user_id` and `payload_base64` are required and must be strings.',
      });
  }

  try {
    const binaryPayload = Buffer.from(payload_base64, 'base64');
    const headers = { user_id };

    // Fanout Exchangeにpublish (ルーティングキーは不要)
    amqpChannel!.publish(RAW_DATA_EXCHANGE, '', binaryPayload, {
      persistent: true,
      headers: headers,
      timestamp: Date.now(),
      contentType: 'application/octet-stream',
      contentEncoding: 'zstd', // ファームウェアからのデータはzstd圧縮済み
    });

    console.log(
      `[HTTP:/data] Published sensor data for user: ${user_id} (${binaryPayload.length} bytes)`,
    );
    res.status(202).json({ status: 'accepted' });
  } catch (error: any) {
    console.error('❌ [HTTP:/data] Error processing request:', error.message);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

/**
 * @route POST /api/v1/media
 * @description メディアファイルとメタデータを受信し、media_processing_queueへ転送する
 * @input Multipart/form-data
 */
app.post('/api/v1/media', checkRabbitMQ, upload.single('file'), (req: Request, res: Response) => {
  // バリデーション
  if (!req.file) {
    return res
      .status(400)
      .json({ error: 'Bad Request', message: 'A media file is required in the `file` field.' });
  }

  const {
    user_id,
    session_id,
    mimetype,
    original_filename,
    timestamp_utc, // for images
    start_time_utc, // for audio
    end_time_utc, // for audio
  } = req.body;

  if (!user_id || !session_id || !mimetype || !original_filename) {
    return res
      .status(400)
      .json({
        error: 'Bad Request',
        message:
          'Missing one or more required metadata fields: user_id, session_id, mimetype, original_filename.',
      });
  }

  try {
    const fileBuffer = req.file.buffer;

    // ヘッダーに全てのメタデータを含める
    const headers = {
      user_id,
      session_id,
      mimetype,
      original_filename,
      ...(timestamp_utc && { timestamp_utc }),
      ...(start_time_utc && { start_time_utc }),
      ...(end_time_utc && { end_time_utc }),
    };

    // 特定のキューに直接送信
    amqpChannel!.sendToQueue(MEDIA_PROCESSING_QUEUE, fileBuffer, {
      persistent: true,
      headers: headers,
      timestamp: Date.now(),
      contentType: mimetype,
    });

    console.log(
      `[HTTP:/media] Queued media file for user: ${user_id}, session: ${session_id} (${fileBuffer.length} bytes)`,
    );
    res.status(202).json({ status: 'accepted' });
  } catch (error: any) {
    console.error('❌ [HTTP:/media] Error processing request:', error.message);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// --- 404 Not Found ハンドラ ---
app.use((req, res, next) => {
  res
    .status(404)
    .json({
      error: 'Not Found',
      message: `The requested endpoint ${req.method} ${req.path} does not exist.`,
    });
});

// --- サーバーの起動 (Server Initialization) ---
server.listen(PORT, () => {
  connectRabbitMQ();
  const address = server.address() as AddressInfo;
  console.log(`🚀 Collector service is running on port ${address.port}`);
});
