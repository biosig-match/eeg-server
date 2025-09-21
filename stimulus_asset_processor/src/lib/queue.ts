import amqp from 'amqplib';
import { config } from './config';
import { handleMessage } from '../services/processor';

/**
 * RabbitMQに接続し、指定されたキューのコンシューマ（メッセージ受信者）を開始します。
 */
export async function startConsumer(): Promise<void> {
  try {
    const connection = await amqp.connect(config.RABBITMQ_URL);
    const channel = await connection.createChannel();

    connection.on('error', (err) => {
      console.error('[RabbitMQ] Connection error:', err.message);
    });
    connection.on('close', () => {
      console.error('[RabbitMQ] Connection closed. Attempting to reconnect...');
      setTimeout(startConsumer, 5000);
    });

    const queue = config.STIMULUS_ASSET_QUEUE;
    await channel.assertQueue(queue, { durable: true });

    // 一度に処理するメッセージを1つに制限
    channel.prefetch(1);

    console.log(`[RabbitMQ] Waiting for messages in queue: "${queue}". To exit press CTRL+C`);

    channel.consume(queue, async (msg) => {
      if (msg !== null) {
        try {
          // メインの処理ロジックを呼び出す
          await handleMessage(msg.content);
          // 処理が成功したので、メッセージをキューから削除
          channel.ack(msg);
        } catch (error) {
          // 処理が失敗したので、メッセージをキューに戻す
          console.error(`[RabbitMQ] Failed to process message. Re-queueing...`);
          channel.nack(msg, false, true);
        }
      }
    });
  } catch (error) {
    console.error('❌ [RabbitMQ] Failed to start consumer.', error);
    // 5秒後に再試行
    setTimeout(startConsumer, 5000);
  }
}
