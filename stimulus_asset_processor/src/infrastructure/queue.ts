import amqp from 'amqplib'
import type { ConsumeMessage } from 'amqplib'
import { config } from '../config/env'
import { handleMessage } from '../domain/services/processor'
import { stimulusAssetJobPayloadSchema } from '../app/schemas/job'
import type { StimulusAssetJobPayload } from '../app/schemas/job'

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>

let amqpConnection: AmqpConnection | null = null;
let amqpChannel: AmqpChannel | null = null;
let consumerTag: string | null = null;
let isConsuming = false;
let lastConnectedAt: Date | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startConsumer().catch((error) => {
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
      console.log(`📡 [RabbitMQ] Connecting (attempt ${attempt})...`);;
      const connection = await amqp.connect(config.RABBITMQ_URL);
      connection.on('error', (err) => {
        console.error('[RabbitMQ] Connection error:', err);
      });
      connection.on('close', () => {
        console.error('❌ [RabbitMQ] Connection closed. Attempting to reconnect...');
        amqpConnection = null;
        amqpChannel = null;
        isConsuming = false;
        consumerTag = null;
        scheduleReconnect();
      });

      const channel = await connection.createChannel();
      channel.on('error', (err) => {
        console.error('[RabbitMQ] Channel error:', err);
      });
      channel.on('close', () => {
        console.warn('[RabbitMQ] Channel closed. Attempting to reconnect...');
        amqpChannel = null;
        isConsuming = false;
        consumerTag = null;
        scheduleReconnect();
      });

      await channel.assertQueue(config.STIMULUS_ASSET_QUEUE, { durable: true });
      await channel.prefetch(1);
      amqpConnection = connection;
      amqpChannel = channel;
      lastConnectedAt = new Date();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      console.log('✅ [RabbitMQ] Channel ready.');;
    } catch (error) {
      amqpConnection = null;
      amqpChannel = null;
      console.error('❌ [RabbitMQ] Failed to establish queue connection.', error);
      const backoff = Math.min(30000, 2 ** attempt * 1000);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

function onMessage(msg: ConsumeMessage | null, channel: AmqpChannel) {
  if (!msg) {
    return;
  }

  handleMessage(msg.content)
    .then(() => {
      channel.ack(msg);
    })
    .catch((error) => {
      console.error('[RabbitMQ] Failed to process message. Re-queueing...', error);
      channel.nack(msg, false, true);
    });
}

export async function startConsumer(): Promise<void> {
  if (!amqpChannel) {
    await connectRabbitMQ();
  }
  const channel = amqpChannel;
  if (!channel) {
    throw new Error('RabbitMQ channel is not available');
  }
  if (isConsuming) {
    return;
  }
  const consumer = await channel.consume(
    config.STIMULUS_ASSET_QUEUE,
    (msg) => onMessage(msg, channel),
  );
  consumerTag = consumer.consumerTag;
  isConsuming = true;
  console.log(
    `🚀 Stimulus Asset Processor is waiting for messages in queue: "${config.STIMULUS_ASSET_QUEUE}"`,
  );
}

export function isChannelReady(): boolean {
  return !!amqpChannel;
}

export function lastRabbitConnection(): Date | null {
  return lastConnectedAt;
}

export function publishStimulusAssetJob(job: StimulusAssetJobPayload): void {
  const channel = amqpChannel;
  if (!channel) {
    throw new Error('RabbitMQ channel is not initialized.');
  }
  const payload = stimulusAssetJobPayloadSchema.parse(job);
  channel.sendToQueue(
    config.STIMULUS_ASSET_QUEUE,
    Buffer.from(JSON.stringify(payload)),
    { persistent: true },
  );
}

export async function shutdownQueue(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const channel = amqpChannel;
  try {
    if (channel && consumerTag) {
      await channel.cancel(consumerTag);
    }
  } catch (error) {
    console.error('[RabbitMQ] Error cancelling consumer during shutdown.', error);
  } finally {
    consumerTag = null;
    isConsuming = false;
  }

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
