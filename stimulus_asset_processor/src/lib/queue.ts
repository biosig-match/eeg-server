import amqp, { Channel, Connection, ConsumeMessage } from 'amqplib'
import { config } from './config'
import { handleMessage } from '../services/processor'
import { stimulusAssetJobPayloadSchema } from '../schemas/job'
import type { StimulusAssetJobPayload } from '../schemas/job'

let amqpConnection: Connection | null = null
let amqpChannel: Channel | null = null
let lastConnectedAt: Date | null = null

export async function startConsumer(): Promise<void> {
  let attempt = 0
  while (!amqpChannel) {
    attempt += 1
    try {
      console.log(`📡 [RabbitMQ] Connecting (attempt ${attempt})...`)
      amqpConnection = await amqp.connect(config.RABBITMQ_URL)
      amqpConnection.on('close', () => {
        console.error('❌ [RabbitMQ] Connection closed. Reconnecting...')
        amqpConnection = null
        amqpChannel = null
        setTimeout(() => {
          startConsumer().catch((error) =>
            console.error('❌ [RabbitMQ] Reconnect failed:', error),
          )
        }, 5000)
      })
      amqpConnection.on('error', (error) => {
        console.error('❌ [RabbitMQ] Connection error:', error)
      })

      amqpChannel = await amqpConnection.createChannel()
      await amqpChannel.assertQueue(config.STIMULUS_ASSET_QUEUE, { durable: true })
      amqpChannel.prefetch(1)
      lastConnectedAt = new Date()

      console.log(
        `[RabbitMQ] Waiting for messages in queue: "${config.STIMULUS_ASSET_QUEUE}". To exit press CTRL+C`,
      )

      amqpChannel.consume(config.STIMULUS_ASSET_QUEUE, (msg) => onMessage(msg, amqpChannel!))
    } catch (error) {
      console.error('❌ [RabbitMQ] Failed to start consumer.', error)
      amqpConnection = null
      amqpChannel = null
      const backoff = Math.min(30000, 2 ** attempt * 1000)
      await new Promise((resolve) => setTimeout(resolve, backoff))
    }
  }
}

function onMessage(msg: ConsumeMessage | null, channel: Channel) {
  if (!msg) {
    return
  }

  handleMessage(msg.content)
    .then(() => {
      channel.ack(msg)
    })
    .catch((error) => {
      console.error(`[RabbitMQ] Failed to process message. Re-queueing...`, error)
      channel.nack(msg, false, true)
    })
}

export function isChannelReady(): boolean {
  return !!amqpChannel
}

export function lastRabbitConnection(): Date | null {
  return lastConnectedAt
}

export function publishStimulusAssetJob(job: StimulusAssetJobPayload): void {
  if (!amqpChannel) {
    throw new Error('RabbitMQ channel is not initialized.')
  }
  const payload = stimulusAssetJobPayloadSchema.parse(job)
  amqpChannel.sendToQueue(
    config.STIMULUS_ASSET_QUEUE,
    Buffer.from(JSON.stringify(payload)),
    { persistent: true },
  )
}
