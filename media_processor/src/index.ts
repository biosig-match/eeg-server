import amqp, { Channel, Connection, ConsumeMessage } from 'amqplib'
import { Client as MinioClient } from 'minio'
import { Pool } from 'pg'
import path from 'path'
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'

const {
  RABBITMQ_URL = 'amqp://guest:guest@rabbitmq',
  DATABASE_URL = 'postgres://admin:password@db:5432/eeg_data',
  MINIO_ENDPOINT = 'minio',
  MINIO_PORT = '9000',
  MINIO_ACCESS_KEY = 'minioadmin',
  MINIO_SECRET_KEY = 'minioadmin',
  MINIO_USE_SSL = 'false',
  MINIO_MEDIA_BUCKET = 'media',
  PORT = '3020',
} = Bun.env

const MEDIA_PROCESSING_QUEUE = 'media_processing_queue'

let amqpConnection: Connection | null = null
let amqpChannel: Channel | null = null
let lastRabbitConnectedAt: Date | null = null

const pgPool = new Pool({ connectionString: DATABASE_URL })
const minioClient = new MinioClient({
  endPoint: MINIO_ENDPOINT,
  port: parseInt(MINIO_PORT, 10),
  useSSL: MINIO_USE_SSL === 'true',
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
})

const app = new Hono()

const mediaMetadataSchema = z
  .object({
    user_id: z.string().min(1, 'user_id is required'),
    session_id: z.string().min(1, 'session_id is required'),
    mimetype: z.string().min(1, 'mimetype is required'),
    original_filename: z.string().min(1, 'original_filename is required'),
    timestamp_utc: z.string().datetime().optional(),
    start_time_utc: z.string().datetime().optional(),
    end_time_utc: z.string().datetime().optional(),
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
    .bucketExists(MINIO_MEDIA_BUCKET)
    .then(() => true)
    .catch((error) => {
      console.error('❌ [MediaProcessor] MinIO health check failed:', error)
      return false
    })

  return c.json({
    status: rabbitStatus && dbStatus && minioStatus ? 'ok' : 'degraded',
    rabbitmq_connected: rabbitStatus,
    db_connected: dbStatus,
    minio_connected: minioStatus,
    last_rabbit_connected_at: lastRabbitConnectedAt?.toISOString() ?? null,
    timestamp: new Date().toISOString(),
  })
})

app.post('/api/v1/preview-object-id', zValidator('json', mediaMetadataSchema), (c) => {
  const metadata = c.req.valid('json')
  const timestamp = new Date(
    (metadata.timestamp_utc || metadata.start_time_utc || Date.now()) as string | number,
  )
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

Bun.serve({
  port: Number(PORT),
  fetch: app.fetch,
})

console.log(`🚀 Media Processor HTTP interface listening on port ${PORT}`)

void bootstrap()

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

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
      amqpConnection = await amqp.connect(RABBITMQ_URL)
      amqpConnection.on('close', () => {
        console.error('❌ [RabbitMQ] Connection closed. Reconnecting...')
        amqpConnection = null
        amqpChannel = null
        setTimeout(() => {
          connectRabbitMQ().catch((error) =>
            console.error('❌ [RabbitMQ] Reconnect failed:', error),
          )
        }, 5000)
      })
      amqpConnection.on('error', (error) => {
        console.error('❌ [RabbitMQ] Connection error:', error)
      })
      amqpChannel = await amqpConnection.createChannel()
      await amqpChannel.assertQueue(MEDIA_PROCESSING_QUEUE, { durable: true })
      lastRabbitConnectedAt = new Date()
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
  amqpChannel.prefetch(5)
  console.log(`🚀 Media Processor waiting for messages in queue: "${MEDIA_PROCESSING_QUEUE}"`)
  amqpChannel.consume(MEDIA_PROCESSING_QUEUE, processMessage)
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

    const timestamp = new Date(
      (metadata.timestamp_utc || metadata.start_time_utc || Date.now()) as string | number,
    )
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
      MINIO_MEDIA_BUCKET,
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
  const bucketExists = await minioClient.bucketExists(MINIO_MEDIA_BUCKET)
  if (!bucketExists) {
    console.log(`[MinIO] Bucket "${MINIO_MEDIA_BUCKET}" does not exist. Creating...`)
    await minioClient.makeBucket(MINIO_MEDIA_BUCKET)
    console.log(`✅ [MinIO] Bucket "${MINIO_MEDIA_BUCKET}" created.`)
  } else {
    console.log(`✅ [MinIO] Bucket "${MINIO_MEDIA_BUCKET}" already exists.`)
  }
}

function shutdown(signal: NodeJS.Signals) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`)
  void amqpChannel?.close()
  void amqpConnection?.close()
  void pgPool.end()
  process.exit(0)
}
