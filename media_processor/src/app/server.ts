import amqp, { Channel, Connection, ConsumeMessage } from 'amqplib'
import { Client as MinioClient } from 'minio'
import { Pool } from 'pg'
import path from 'path'
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'

import { config } from '../config/env'

const PREFETCH_COUNT = config.MEDIA_PREFETCH

let amqpConnection: Connection | null = null
let amqpChannel: Channel | null = null
let consumerTag: string | null = null
let isConsuming = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let lastRabbitConnectedAt: Date | null = null

const pgPool = new Pool({ connectionString: config.DATABASE_URL })
const minioClient = new MinioClient({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
})

const app = new Hono()

app.get('/health', async (c) => {
  const rabbitStatus = !!amqpChannel
  const dbStatus = await pgPool.query('SELECT 1').then(() => true).catch(() => false)
  const minioStatus = await minioClient.bucketExists(config.MINIO_MEDIA_BUCKET).then(() => true).catch(() => false)
  const allOk = rabbitStatus && dbStatus && minioStatus
  return c.json(
    { status: allOk ? 'ok' : 'unhealthy' },
    allOk ? 200 : 503,
  )
})

const mediaMetadataSchema = z
  .object({
    user_id: z.string().min(1, 'user_id is required'),
    session_id: z.string().min(1, 'session_id is required'),
    mimetype: z.string().min(1, 'mimetype is required'),
    original_filename: z.string().min(1, 'original_filename is required'),
    timestamp_utc: z.coerce.date().optional(),
    start_time_utc: z.coerce.date().optional(),
    end_time_utc: z.coerce.date().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mimetype.startsWith('image') && !value.timestamp_utc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timestamp_utc'],
        message: 'timestamp_utc is required for image uploads',
      })
    }
    if (value.mimetype.startsWith('audio')) {
      if (!value.start_time_utc || !value.end_time_utc) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['start_time_utc'],
          message: 'start_time_utc and end_time_utc are required for audio uploads',
        })
      }
    }
  })

app.get('/api/v1/health', async (c) => {
  const rabbitStatus = !!amqpChannel
  const dbStatus = await pgPool
    .query('SELECT 1')
    .then(() => true)
    .catch((error) => {
      console.error('❌ [MediaProcessor] DB health check failed:', error)
      return false
    })
  const minioStatus = await minioClient
    .bucketExists(config.MINIO_MEDIA_BUCKET)
    .then(() => true)
    .catch((error) => {
      console.error('❌ [MediaProcessor] MinIO health check failed:', error)
      return false
    })

  return c.json(
    {
      status: rabbitStatus && dbStatus && minioStatus ? 'ok' : 'degraded',
      rabbitmq_connected: rabbitStatus,
      db_connected: dbStatus,
      minio_connected: minioStatus,
      last_rabbit_connected_at: lastRabbitConnectedAt?.toISOString() ?? null,
      timestamp: new Date().toISOString(),
    },
    rabbitStatus && dbStatus && minioStatus ? 200 : 503,
  )
})

app.post('/api/v1/preview-object-id', zValidator('json', mediaMetadataSchema), (c) => {
  const metadata = c.req.valid('json')
  const timestamp = metadata.timestamp_utc ?? metadata.start_time_utc ?? new Date()
  const timestampMs = timestamp.getTime()
  const mediaType = metadata.mimetype.startsWith('image') ? 'photo' : 'audio'
  const extension = path.extname(metadata.original_filename)
  const objectId = `media/${metadata.user_id}/${metadata.session_id}/${timestampMs}_${mediaType}${extension}`
  return c.json({ object_id: objectId })
})

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  console.error('❌ [MediaProcessor] Unhandled error:', err)
  return c.json({ error: 'Internal Server Error' }, 500)
})

app.notFound((c) =>
  c.json(
    {
      message: `The requested endpoint ${c.req.method} ${c.req.path} does not exist.`,
    },
    404,
  ),
)

export const mediaProcessorApp = app

export async function startMediaProcessorService() {
  const server = Bun.serve({
    port: config.PORT,
    fetch: app.fetch,
  })

  console.log(`🚀 Media Processor HTTP interface listening on port ${server.port}`)

  void bootstrap()

  process.on('SIGINT', (signal) => {
    void shutdown(signal)
  })
  process.on('SIGTERM', (signal) => {
    void shutdown(signal)
  })

  return server
}

if (import.meta.main) {
  startMediaProcessorService().catch((error) => {
    console.error('❌ Media Processor bootstrap failed:', error)
    process.exit(1)
  })
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectRabbitMQ().catch((error) => {
      console.error('❌ [RabbitMQ] Reconnect failed:', error)
      scheduleReconnect()
    })
  }, 5000)
}

async function reconnectRabbitMQ() {
  await connectRabbitMQ()
  await startConsumer()
  console.log('✅ [RabbitMQ] Reconnected and consumer restarted')
}

async function bootstrap() {
  try {
    await ensureMinioBucket()
    await connectRabbitMQ()
    await startConsumer()
  } catch (error) {
    console.error('❌ Media Processor bootstrap failed:', error)
    process.exit(1)
  }
}

async function connectRabbitMQ() {
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
        isConsuming = false
        consumerTag = null
        scheduleReconnect()
      })
      amqpConnection.on('error', (error) => {
        console.error('❌ [RabbitMQ] Connection error:', error)
      })
      amqpChannel = await amqpConnection.createChannel()
      await amqpChannel.assertQueue(config.MEDIA_PROCESSING_QUEUE, { durable: true })
      lastRabbitConnectedAt = new Date()
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      console.log('✅ [RabbitMQ] Channel ready.')
    } catch (error) {
      amqpConnection = null
      amqpChannel = null
      console.error('❌ [RabbitMQ] Connection attempt failed:', error)
      const backoff = Math.min(30000, 2 ** attempt * 1000)
      await new Promise((resolve) => setTimeout(resolve, backoff))
    }
  }
}

async function startConsumer() {
  if (!amqpChannel) {
    throw new Error('RabbitMQ channel is not available')
  }
  if (isConsuming) {
    return
  }
  amqpChannel.prefetch(PREFETCH_COUNT)
  const consumer = await amqpChannel.consume(config.MEDIA_PROCESSING_QUEUE, processMessage)
  consumerTag = consumer.consumerTag
  isConsuming = true
  console.log(`🚀 Media Processor waiting for messages in queue: "${config.MEDIA_PROCESSING_QUEUE}"`)
}

async function processMessage(msg: ConsumeMessage | null) {
  if (!msg) return

  try {
    const fileBuffer = msg.content
    const headers = msg.properties?.headers

    if (!headers) {
      console.warn('Message missing headers. Acknowledging and discarding.')
      amqpChannel?.ack(msg)
      return
    }

    const metadataResult = mediaMetadataSchema.safeParse(headers)
    if (!metadataResult.success) {
      console.warn('Message headers failed validation. Discarding.', metadataResult.error)
      amqpChannel?.nack(msg, false, false)
      return
    }
    const metadata = metadataResult.data

    const timestamp = metadata.timestamp_utc ?? metadata.start_time_utc ?? new Date()
    const timestampMs = timestamp.getTime()
    const mediaType = metadata.mimetype.startsWith('image') ? 'photo' : 'audio'
    const extension = path.extname(metadata.original_filename)
    const objectId = `media/${metadata.user_id}/${metadata.session_id}/${timestampMs}_${mediaType}${extension}`

    const metaData = {
      'Content-Type': metadata.mimetype,
      'X-User-Id': metadata.user_id,
      'X-Session-Id': metadata.session_id,
      'X-Original-Filename': metadata.original_filename,
    }
    await minioClient.putObject(
      config.MINIO_MEDIA_BUCKET,
      objectId,
      fileBuffer,
      fileBuffer.length,
      metaData,
    )
    console.log(`[MinIO] Successfully uploaded: ${objectId}`)

    if (mediaType === 'photo') {
      await pgPool.query(
        `
        INSERT INTO images (object_id, user_id, session_id, timestamp_utc)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (object_id) DO NOTHING;
      `,
        [objectId, metadata.user_id, metadata.session_id, metadata.timestamp_utc],
      )
    } else if (mediaType === 'audio') {
      await pgPool.query(
        `
        INSERT INTO audio_clips (object_id, user_id, session_id, start_time, end_time)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (object_id) DO NOTHING;
      `,
        [
          objectId,
          metadata.user_id,
          metadata.session_id,
          metadata.start_time_utc,
          metadata.end_time_utc,
        ],
      )
    }

    console.log(`[PostgreSQL] Successfully inserted metadata for: ${objectId}`)
    amqpChannel?.ack(msg)
  } catch (error: any) {
    console.error('❌ Error processing media message:', error.message)
    amqpChannel?.nack(msg, false, true)
  }
}

async function ensureMinioBucket() {
  const bucketExists = await minioClient.bucketExists(config.MINIO_MEDIA_BUCKET)
  if (!bucketExists) {
    console.log(`[MinIO] Bucket "${config.MINIO_MEDIA_BUCKET}" does not exist. Creating...`)
    await minioClient.makeBucket(config.MINIO_MEDIA_BUCKET)
    console.log(`✅ [MinIO] Bucket "${config.MINIO_MEDIA_BUCKET}" created.`)
  } else {
    console.log(`✅ [MinIO] Bucket "${config.MINIO_MEDIA_BUCKET}" already exists.`)
  }
}

async function shutdown(signal: NodeJS.Signals) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`)
  try {
    if (amqpChannel && consumerTag) {
      await amqpChannel.cancel(consumerTag)
      isConsuming = false
      consumerTag = null
    }
    await amqpChannel?.close()
    await amqpConnection?.close()
    await pgPool.end()
    console.log('✅ Graceful shutdown completed')
  } catch (error) {
    console.error('❌ Error during shutdown:', error)
  } finally {
    process.exit(0)
  }
}
