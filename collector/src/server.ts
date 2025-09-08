import amqp, { Channel, Connection } from 'amqplib';
import express from 'express';
import http from 'http';
import multer from 'multer';
import { AddressInfo } from 'net';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';

// --- 環境変数と設定 ---
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq';
const PORT = process.env.PORT || 3000;
const RAW_DATA_EXCHANGE = 'raw_data_exchange';

// --- Expressアプリケーションのセットアップ ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({ storage: multer.memoryStorage() });

let amqpConnection: Connection | null = null;
let amqpChannel: Channel | null = null;

// --- RabbitMQ接続・再接続ロジック ---
async function connectRabbitMQ() {
  let attempts = 0;
  while (true) {
    try {
      console.log(`[RabbitMQ] 接続を試みています... (試行回数: ${attempts + 1})`);

      // ★★★ これが公式ライブラリの正しい接続方法です ★★★
      const connection = await amqp.connect(RABBITMQ_URL);

      connection.on('close', () => {
        console.error('❌ [RabbitMQ] 接続が閉じられました。5秒後に再接続します...');
        amqpConnection = null;
        amqpChannel = null;
        setTimeout(connectRabbitMQ, 5000);
      });
      connection.on('error', (err) => {
        console.error('❌ [RabbitMQ] 接続エラー:', err.message);
      });

      console.log('✅ [RabbitMQ] 接続に成功しました。');
      amqpConnection = connection;
      await createChannel();
      break;
    } catch (err: any) {
      console.error(`❌ [RabbitMQ] 接続に失敗しました: ${err.message}`);
      attempts++;
      const delay = Math.min(30000, 2 ** attempts * 1000);
      console.log(`[RabbitMQ] ${delay / 1000}秒後に再試行します...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function createChannel() {
  if (!amqpConnection) {
    console.warn('[RabbitMQ] チャネル作成スキップ: 接続がありません。');
    return;
  }
  try {
    // ★★★ Connectionオブジェクトからチャネルを作成します ★★★
    amqpChannel = await amqpConnection.createChannel();
    console.log('✅ [RabbitMQ] チャネルを作成しました。');
    await amqpChannel.assertExchange(RAW_DATA_EXCHANGE, 'topic', { durable: true });
    console.log(`✅ [RabbitMQ] エクスチェンジ "${RAW_DATA_EXCHANGE}" の準備が完了しました。`);
  } catch (err: any) {
    console.error('❌ [RabbitMQ] チャネルの作成に失敗しました:', err.message);
    amqpChannel = null;
  }
}

// --- WebSocketサーバー ---
wss.on('connection', (ws) => {
  console.log('[WebSocket] クライアントが接続しました。');
  ws.on('message', (message) => {
    // ★★★ Nullチェックを確実に行います ★★★
    if (amqpChannel) {
      try {
        const parsedMessage = JSON.parse(message.toString());
        amqpChannel.publish(
          RAW_DATA_EXCHANGE,
          'eeg.raw',
          Buffer.from(JSON.stringify(parsedMessage)),
          { persistent: true },
        );
      } catch (e) {
        console.error('[WebSocket] 受信メッセージの解析に失敗:', e);
      }
    } else {
      console.warn('[WebSocket] メッセージを破棄しました: RabbitMQチャネルが利用できません。');
    }
  });
  ws.on('close', () => console.log('[WebSocket] クライアントが切断されました。'));
});

// --- HTTP APIエンドポイント ---
app.get('/api/v1/health', (req, res) => {
  res.status(200).json({ status: 'ok', rabbitmq_connected: !!amqpChannel });
});

app.post(
  '/api/v1/media',
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'audio', maxCount: 1 },
  ]),
  (req, res) => {
    if (!amqpChannel) {
      return res.status(503).json({ error: 'メッセージブローカーが利用できません。' });
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };

    const message = {
      message_id: uuidv4(),
      device_id: req.body.device_id,
      epoch_id: parseInt(req.body.epoch_id, 10),
      experiment_id: req.body.experiment_id || null,
      timestamp_ms: parseFloat(req.body.timestamp_ms),
      image: files.image
        ? {
            payload: files.image[0].buffer.toString('base64'),
            mimetype: files.image[0].mimetype,
          }
        : null,
      audio: files.audio
        ? {
            payload: files.audio[0].buffer.toString('base64'),
            mimetype: files.audio[0].mimetype,
          }
        : null,
    };

    amqpChannel.publish(RAW_DATA_EXCHANGE, 'media.raw', Buffer.from(JSON.stringify(message)), {
      persistent: true,
    });
    res.status(202).json({ status: 'accepted' });
  },
);

// --- サーバーの起動 ---
server.listen(PORT, () => {
  connectRabbitMQ();
  const address = server.address() as AddressInfo;
  console.log(`🚀 Collectorサービスがポート ${address.port} で起動しました。`);
});
