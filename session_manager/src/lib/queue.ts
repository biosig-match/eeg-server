import amqp from 'amqplib';
import { config } from './config';

let amqpConnection: amqp.Connection | null = null;
let amqpChannel: amqp.Channel | null = null;

export async function initializeQueue(): Promise<void> {
  if (amqpChannel && amqpConnection) {
    return;
  }

  try {
    const connection = await amqp.connect(config.RABBITMQ_URL);
    amqpConnection = connection;

    amqpConnection.on('error', (err) => {
      console.error('[RabbitMQ] Connection error:', err.message);
      amqpConnection = null;
      amqpChannel = null;
    });

    amqpConnection.on('close', () => {
      console.warn(
        '[RabbitMQ] Connection closed. Subsequent operations will fail until re-initialized.',
      );
      // 接続が閉じた場合、変数をリセット
      amqpConnection = null;
      amqpChannel = null;
    });

    // チャネルを作成
    const channel = await amqpConnection.createChannel();
    amqpChannel = channel;

    amqpChannel.on('error', (err) => {
      console.error('[RabbitMQ] Channel error:', err.message);
    });
    amqpChannel.on('close', () => {
      console.warn('[RabbitMQ] Channel closed.');
      amqpChannel = null;
    });

    await amqpChannel.assertQueue(config.DATA_LINKER_QUEUE, { durable: true });
  } catch (error) {
    console.error('❌ [RabbitMQ] Failed to connect during initialization.', error);
    process.exit(1);
  }
}

/**
 * 準備済みのAMQPチャネルを取得する。
 * @returns {amqp.Channel} AMQPチャネル
 * @throws {Error} チャネルが利用できない場合にエラーをスローする
 */
export function getAmqpChannel(): amqp.Channel {
  if (!amqpChannel) {
    throw new Error('AMQP channel is not available. It might be disconnected or not initialized.');
  }
  return amqpChannel;
}
