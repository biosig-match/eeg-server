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
const COLLECTOR_MQ_FORMAT = (process.env.COLLECTOR_MQ_FORMAT || 'json').toLowerCase();

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
    const shouldPublishJson = COLLECTOR_MQ_FORMAT === 'json' || COLLECTOR_MQ_FORMAT === 'both';
    const shouldPublishBin = COLLECTOR_MQ_FORMAT === 'bin' || COLLECTOR_MQ_FORMAT === 'both';

    if (!amqpChannel) {
      console.warn('[WebSocket] メッセージを破棄しました: RabbitMQチャネルが利用できません。');
      return;
    }

    // RawData: Buffer | ArrayBuffer | string | Buffer[]
    const isBuffer = Buffer.isBuffer(message);
    const isArrayBuffer = (message as any) instanceof ArrayBuffer;
    const toBuffer = (): Buffer => {
      if (isBuffer) return message as Buffer;
      if (isArrayBuffer) return Buffer.from(message as ArrayBuffer);
      if (Array.isArray(message)) return Buffer.concat(message as Buffer[]);
      return Buffer.from(String(message));
    };

    // Heuristic: treat as JSON if it looks like JSON text
    const asString = (() => {
      try {
        if (typeof message === 'string') return message as string;
        if (isBuffer) return (message as Buffer).toString('utf8');
        if (isArrayBuffer) return Buffer.from(message as ArrayBuffer).toString('utf8');
        if (Array.isArray(message)) return Buffer.concat(message as Buffer[]).toString('utf8');
      } catch (_) {
        /* noop */
      }
      return '';
    })();

    const looksLikeJson = asString.trim().startsWith('{') && asString.trim().endsWith('}');

    try {
      if (looksLikeJson) {
        const parsed = JSON.parse(asString);

        // Always allow legacy JSON publish if enabled
        if (shouldPublishJson) {
          amqpChannel.publish(
            RAW_DATA_EXCHANGE,
            'eeg.raw',
            Buffer.from(JSON.stringify(parsed)),
            { persistent: true },
          );
        }

        // If binary route enabled and payload present, publish v2 message
        if (shouldPublishBin) {
          const base64Payload: string | undefined = parsed?.payload;
          if (typeof base64Payload === 'string' && base64Payload.length > 0) {
            const compressed = Buffer.from(base64Payload, 'base64');
            const headers: Record<string, any> = {
              device_id: parsed?.device_id ?? 'unknown',
              experiment_id: parsed?.experiment_id ?? null,
              epoch_id: parsed?.epoch_id ?? null,
              server_received_timestamp:
                parsed?.server_received_timestamp ?? new Date().toISOString(),
              schema_version: 'v2-bin',
            };
            amqpChannel.publish(
              RAW_DATA_EXCHANGE,
              'eeg.raw.bin',
              compressed,
              {
                persistent: true,
                contentType: 'application/octet-stream',
                contentEncoding: 'zstd',
                timestamp: Math.floor(Date.now() / 1000),
                headers,
              },
            );
          } else if (!shouldPublishJson) {
            console.warn('[Collector] BIN出力が有効ですが、JSONにpayloadがありません。スキップしました。');
          }
        }
      } else {
        // Binary WebSocket: requires metadata for headers; defer until WS v2 finalized
        if (shouldPublishBin) {
          console.warn('[Collector] バイナリWS入力はメタデータ不足のため未対応（TODO: v2 WS）');
        }
      }
    } catch (e: any) {
      console.error('[WebSocket] 受信メッセージ処理に失敗:', e?.message || e);
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
