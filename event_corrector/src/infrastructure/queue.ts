import amqp, { Channel, Connection, ConsumeMessage } from 'amqplib'
import { config } from '../config/env'
import { eventCorrectorJobPayloadSchema } from '../app/schemas/job'
import { handleEventCorrectorJob } from '../domain/services/corrector'
import type { EventCorrectorJobPayload } from '../app/schemas/job'

let amqpConnection: Connection | null = null
let amqpChannel: Channel | null = null
let consumerTag: string | null = null
let isConsuming = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

async function onMessage(msg: ConsumeMessage | null) {
  if (!msg) return;

  let jobPayload;
  try {
    const jobData = JSON.parse(msg.content.toString());
    jobPayload = eventCorrectorJobPayloadSchema.parse(jobData);

    await handleEventCorrectorJob(jobPayload)
    amqpChannel?.ack(msg)
  } catch (error) {
    const message = { content: msg.content.toString(), error }
    if (isTransientError(error)) {
      console.warn('[Queue] ⚠️ Transient error. Re-queueing message.', message)
      amqpChannel?.nack(msg, false, true)
    } else {
      console.error('[Queue] ❌ Permanent error. Discarding message.', message)
      amqpChannel?.nack(msg, false, false)
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startConsumer().catch((error) => {
      console.error('❌ [RabbitMQ] Reconnect failed.', error)
      scheduleReconnect()
    })
  }, 5000)
}

function isTransientError(error: any): boolean {
  if (!error) {
    return false
  }
  if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true
  }
  if (error.code === '08006' || error.code === '08003' || error.code === '57P03') {
    return true
  }
  const message = typeof error.message === 'string' ? error.message : ''
  if (message.includes('timeout') || message.includes('ECONNRESET') || message.includes('503')) {
    return true
  }
  return false
}

export async function startConsumer(): Promise<void> {
  if (amqpChannel) {
    return
  }
  try {
    const connection = await amqp.connect(config.RABBITMQ_URL)
    connection.on('error', (err) => {
      console.error('[RabbitMQ] Connection error:', err)
    })
    connection.on('close', () => {
      console.error('[RabbitMQ] Connection closed. Attempting to reconnect...')
      amqpConnection = null
      amqpChannel = null
      isConsuming = false
      consumerTag = null
      scheduleReconnect()
    })

    const channel = await connection.createChannel()
    channel.on('error', (err) => {
      console.error('[RabbitMQ] Channel error:', err)
    })
    channel.on('close', () => {
      console.warn('[RabbitMQ] Channel closed. Attempting to reconnect...')
      amqpChannel = null
      isConsuming = false
      consumerTag = null
      scheduleReconnect()
    })

    const queue = config.EVENT_CORRECTION_QUEUE
    await channel.assertQueue(queue, { durable: true })
    await channel.prefetch(1)

    amqpConnection = connection
    amqpChannel = channel

    const consumer = await channel.consume(queue, onMessage)
    consumerTag = consumer.consumerTag
    isConsuming = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    console.log(`[RabbitMQ] Waiting for messages in queue: "${queue}"`)
  } catch (error) {
    amqpConnection = null
    amqpChannel = null
    isConsuming = false
    consumerTag = null
    throw error
  }
}

export function isChannelReady(): boolean {
  return !!amqpChannel
}

export function publishEventCorrectionJob(job: EventCorrectorJobPayload): void {
  if (!amqpChannel) {
    throw new Error('RabbitMQ channel is not initialized.')
  }

  const payload = eventCorrectorJobPayloadSchema.parse(job)
  amqpChannel.sendToQueue(
    config.EVENT_CORRECTION_QUEUE,
    Buffer.from(JSON.stringify(payload)),
    { persistent: true },
  )
}

export async function shutdownQueue(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  try {
    if (amqpChannel && consumerTag) {
      await amqpChannel.cancel(consumerTag)
    }
  } catch (error) {
    console.error('[RabbitMQ] Error cancelling consumer during shutdown.', error)
  } finally {
    consumerTag = null
    isConsuming = false
  }

  try {
    await amqpChannel?.close()
  } catch (error) {
    console.error('[RabbitMQ] Error closing channel during shutdown.', error)
  } finally {
    amqpChannel = null
  }

  try {
    await amqpConnection?.close()
  } catch (error) {
    console.error('[RabbitMQ] Error closing connection during shutdown.', error)
  } finally {
    amqpConnection = null
  }
}
