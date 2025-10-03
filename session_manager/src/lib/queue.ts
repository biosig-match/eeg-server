import amqp from 'amqplib';
import { config } from './config';

let amqpConnection: amqp.Connection | null = null;
let amqpChannel: amqp.Channel | null = null;
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
      amqpConnection = await amqp.connect(config.RABBITMQ_URL);
      amqpConnection.on('error', (err) => {
        console.error('[RabbitMQ] Connection error:', err);
      });
      amqpConnection.on('close', () => {
        console.error('❌ [RabbitMQ] Connection closed. Attempting to reconnect...');
        amqpConnection = null;
        amqpChannel = null;
        scheduleReconnect();
      });

      amqpChannel = await amqpConnection.createChannel();
      amqpChannel.on('error', (err) => {
        console.error('[RabbitMQ] Channel error:', err);
      });
      amqpChannel.on('close', () => {
        console.warn('[RabbitMQ] Channel closed. Reconnecting...');
        amqpChannel = null;
        scheduleReconnect();
      });

      await amqpChannel.assertQueue(config.DATA_LINKER_QUEUE, { durable: true });
      await amqpChannel.assertQueue(config.STIMULUS_ASSET_QUEUE, { durable: true });
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

export function getAmqpChannel(): amqp.Channel {
  if (!amqpChannel) {
    throw new Error('AMQP channel is not available. It might be disconnected or not initialized.');
  }
  return amqpChannel;
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
  try {
    await amqpChannel?.close();
  } catch (error) {
    console.error('[RabbitMQ] Error closing channel during shutdown.', error);
  } finally {
    amqpChannel = null;
  }

  try {
    await amqpConnection?.close();
  } catch (error) {
    console.error('[RabbitMQ] Error closing connection during shutdown.', error);
  } finally {
    amqpConnection = null;
  }
}
