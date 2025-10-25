import amqp from 'amqplib';
import { config } from '../config/env';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

let amqpConnection: AmqpConnection | null = null;
let amqpChannel: AmqpChannel | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastConnectedAt: Date | null = null;

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initializeQueue().catch((error) => {
      console.error('❌ [RabbitMQ] Reconnect failed.', error);
      scheduleReconnect();
    });
  }, 5000);
}

async function connectRabbitMQ(): Promise<void> {
  let attempt = 0;
  while (!amqpChannel) {
    attempt += 1;
    try {
      console.log(`📡 [RabbitMQ] Connecting (attempt ${attempt})...`);
      const connection = await amqp.connect(config.RABBITMQ_URL);
      connection.on('error', (err) => {
        console.error('[RabbitMQ] Connection error:', err);
      });
      connection.on('close', () => {
        console.error('❌ [RabbitMQ] Connection closed. Attempting to reconnect...');
        amqpConnection = null;
        amqpChannel = null;
        scheduleReconnect();
      });

      const channel = await connection.createChannel();
      channel.on('error', (err) => {
        console.error('[RabbitMQ] Channel error:', err);
      });
      channel.on('close', () => {
        console.warn('[RabbitMQ] Channel closed. Reconnecting...');
        amqpChannel = null;
        scheduleReconnect();
      });

      await channel.assertQueue(config.DATA_LINKER_QUEUE, { durable: true });
      await channel.assertQueue(config.STIMULUS_ASSET_QUEUE, { durable: true });

      amqpConnection = connection;
      amqpChannel = channel;
      lastConnectedAt = new Date();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      console.log('✅ [RabbitMQ] Channel ready.');
    } catch (error) {
      amqpConnection = null;
      amqpChannel = null;
      console.error('❌ [RabbitMQ] Failed to establish channel.', error);
      const backoff = Math.min(30000, 2 ** attempt * 1000);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

export async function initializeQueue(): Promise<void> {
  if (amqpChannel) {
    return;
  }
  await connectRabbitMQ();
}

export function getAmqpChannel(): AmqpChannel {
  const channel = amqpChannel;
  if (!channel) {
    throw new Error('AMQP channel is not available. It might be disconnected or not initialized.');
  }
  return channel;
}

export function isQueueReady(): boolean {
  return !!amqpChannel;
}

export function getLastRabbitConnection(): Date | null {
  return lastConnectedAt;
}

export async function shutdownQueue(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const channel = amqpChannel;
  try {
    await channel?.close();
  } catch (error) {
    console.error('[RabbitMQ] Error closing channel during shutdown.', error);
  } finally {
    amqpChannel = null;
  }

  const connection = amqpConnection;
  try {
    await connection?.close();
  } catch (error) {
    console.error('[RabbitMQ] Error closing connection during shutdown.', error);
  } finally {
    amqpConnection = null;
  }
}
