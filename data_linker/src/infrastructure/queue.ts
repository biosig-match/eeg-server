import amqp, { Channel, ConsumeMessage } from 'amqplib'
import { config } from '../config/env'
import { handleLinkerJob } from '../domain/services/linker'
import { dataLinkerJobPayloadSchema } from '../app/schemas/job'

let amqpChannel: Channel | null = null;

/**
 * Returns the active AMQP channel.
 * Throws an error if the channel is not initialized.
 * @returns {Channel} The active amqplib Channel.
 */
export function getAmqpChannel(): Channel {
  if (!amqpChannel) {
    throw new Error('RabbitMQ channel has not been initialized. Call startConsumer first.');
  }
  return amqpChannel;
}

/**
 * Connects to RabbitMQ and starts consuming messages from the data linker queue.
 */
export async function startConsumer(): Promise<void> {
  try {
    const connection = await amqp.connect(config.RABBITMQ_URL);
    connection.on('error', (err) => {
      console.error('[RabbitMQ] Connection error:', err.message);
    });
    connection.on('close', () => {
      console.error('[RabbitMQ] Connection closed. Attempting to reconnect...');
      amqpChannel = null;
      setTimeout(() => {
        void startConsumer();
      }, 5000);
    });

    const channel = await connection.createChannel();
    channel.on('error', (err) => {
      console.error('[RabbitMQ] Channel error:', err);
    });
    channel.on('close', () => {
      console.warn('[RabbitMQ] Channel closed. Attempting to reconnect...');
      amqpChannel = null;
      setTimeout(() => {
        void startConsumer();
      }, 5000);
    });

    const queue = config.DATA_LINKER_QUEUE;
    await channel.assertQueue(queue, { durable: true });
    await channel.prefetch(1);

    amqpChannel = channel;

    console.log(`[RabbitMQ] Waiting for messages in queue: "${queue}"`);

    await channel.consume(queue, (msg) => processMessage(msg, channel));
  } catch (error) {
    console.error('❌ [RabbitMQ] Failed to start consumer.', error);
    setTimeout(() => {
      void startConsumer();
    }, 5000);
  }
}

/**
 * Handles an individual message from the queue, including parsing,
 * validation, and delegating to the main job handler.
 * @param msg The consumed message from amqplib.
 * @param channel The amqp channel to ack/nack the message.
 */
async function processMessage(msg: ConsumeMessage | null, channel: Channel) {
  if (!msg) {
    return;
  }

  let jobPayload;
  try {
    const jsonPayload = JSON.parse(msg.content.toString());
    jobPayload = dataLinkerJobPayloadSchema.parse(jsonPayload);
  } catch (error) {
    console.error('❌ Invalid message format. Discarding message.', error);
    // Discard malformed messages (don't re-queue)
    channel.ack(msg);
    return;
  }

  try {
    await handleLinkerJob(jobPayload);
    // Acknowledge the message on successful processing
    channel.ack(msg);
  } catch (error) {
    console.error('❌ Failed to process job. Re-queueing message...');
    // Negative-acknowledge and re-queue the message for a later attempt
    channel.nack(msg, false, true);
  }
}
