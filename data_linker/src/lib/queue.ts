import amqp, { Channel, Connection, ConsumeMessage } from 'amqplib';
import { config } from './config';
import { handleLinkerJob } from '../services/linker';
import { dataLinkerJobPayloadSchema } from '../schemas/job';

let amqpConnection: Connection | null = null;
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
    amqpConnection = await amqp.connect(config.RABBITMQ_URL);
    amqpChannel = await amqpConnection.createChannel();

    amqpConnection.on('error', (err) => {
      console.error('[RabbitMQ] Connection error:', err.message);
    });
    amqpConnection.on('close', () => {
      console.error('[RabbitMQ] Connection closed. Attempting to reconnect...');
      setTimeout(startConsumer, 5000); // Reconnect after 5 seconds
    });

    const queue = config.DATA_LINKER_QUEUE;
    await amqpChannel.assertQueue(queue, { durable: true });

    // Process one message at a time to ensure data consistency
    amqpChannel.prefetch(1);

    console.log(`[RabbitMQ] Waiting for messages in queue: "${queue}"`);

    amqpChannel.consume(queue, (msg) => processMessage(msg, amqpChannel!));
  } catch (error) {
    console.error('❌ [RabbitMQ] Failed to start consumer.', error);
    setTimeout(startConsumer, 5000); // Retry connection on startup failure
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
