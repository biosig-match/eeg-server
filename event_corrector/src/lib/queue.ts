import amqp, { Channel, Connection, ConsumeMessage } from 'amqplib';
import { config } from './config';
import { eventCorrectorJobPayloadSchema } from '@/schemas/job';
import { handleEventCorrectorJob } from '@/services/corrector';

let amqpConnection: Connection | null = null;
let amqpChannel: Channel | null = null;

async function onMessage(msg: ConsumeMessage | null) {
  if (!msg) return;

  let jobPayload;
  try {
    const jobData = JSON.parse(msg.content.toString());
    jobPayload = eventCorrectorJobPayloadSchema.parse(jobData);

    await handleEventCorrectorJob(jobPayload);
    amqpChannel?.ack(msg);
  } catch (error) {
    console.error('[Queue] ❌ Error processing message. NACKing and not re-queueing.', {
      content: msg.content.toString(),
      error,
    });
    amqpChannel?.nack(msg, false, false);
  }
}

export async function startConsumer(): Promise<void> {
  try {
    amqpConnection = await amqp.connect(config.RABBITMQ_URL);
    amqpChannel = await amqpConnection.createChannel();

    const queue = config.EVENT_CORRECTION_QUEUE;
    await amqpChannel.assertQueue(queue, { durable: true });
    amqpChannel.prefetch(1);

    console.log(`[RabbitMQ] Waiting for messages in queue: "${queue}"`);
    amqpChannel.consume(queue, onMessage);
  } catch (error) {
    console.error('❌ [RabbitMQ] Failed to start consumer. Retrying in 5s.', error);
    setTimeout(startConsumer, 5000);
  }
}
