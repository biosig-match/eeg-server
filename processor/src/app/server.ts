import amqp, { Channel, Connection, ConsumeMessage } from 'amqplib'
import { Client as MinioClient } from 'minio'
import { Pool } from 'pg'
import { init as zstdInit, decompress as zstdDecompressRaw } from '@bokuweb/zstd-wasm'
import { v4 as uuidv4 } from 'uuid'
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'

import { config } from '../config/env'

const zstdDecompress: (buf: Uint8Array) => Uint8Array = zstdDecompressRaw as any

const HEADER_SIZE = 18
const POINT_SIZE = 53

let amqpConnection: Connection | null = null
let amqpChannel: Channel | null = null
let consumerTag: string | null = null
let isConsuming = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const pgPool = new Pool({ connectionString: config.DATABASE_URL })
const minioClient = new MinioClient({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
})

let lastRabbitConnectedAt: Date | null = null
let zstdInitialized = false

const app = new Hono()

const inspectSchema = z.object({
  payload_base64: z.string().min(1, 'payload_base64 is required'),
})

app.get('/api/v1/health', async (c) => {
  const rabbitStatus = !!amqpChannel
  const dbStatus = await pgPool
    .query('SELECT 1')
    .then(() => true)
    .catch((error) => {
      console.error('❌ [Processor] DB health check failed:', error)
      return false
    })
  return c.json({
    status: rabbitStatus && dbStatus ? 'ok' : 'degraded',
    rabbitmq_connected: rabbitStatus,
    db_connected: dbStatus,
    last_rabbit_connected_at: lastRabbitConnectedAt?.toISOString() ?? null,
    timestamp: new Date().toISOString(),
  })
})

app.post('/api/v1/inspect', zValidator('json', inspectSchema), async (c) => {
  await ensureZstdReady()
  const { payload_base64 } = c.req.valid('json')
  let payload: Buffer
  try {
    payload = Buffer.from(payload_base64, 'base64')
  } catch (error) {
    throw new HTTPException(400, { message: 'payload_base64 must be valid base64', cause: error })
  }

  const payloadView = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  const decompressedData = zstdDecompress(payloadView)
  const decompressedBuffer = Buffer.from(decompressedData)
  const metadata = extractMetadataFromPacket(decompressedBuffer)

  return c.json({
    ...metadata,
    decompressed_size: decompressedBuffer.byteLength,
  })
})

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  console.error('❌ [Processor] Unhandled error:', err)
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

export const processorApp = app

export async function startProcessorService() {
  const server = Bun.serve({
    port: config.PORT,
    fetch: app.fetch,
  })

  console.log(`🚀 Processor service HTTP interface listening on port ${server.port}`)

  await bootstrap()

  process.on('SIGINT', (signal) => {
    void shutdown(signal)
  })
  process.on('SIGTERM', (signal) => {
    void shutdown(signal)
  })

  return server
}

async function bootstrap() {
  try {
    await ensureZstdReady()
    await ensureMinioBucket()
    await connectRabbitMQ()
    await startConsumer()
  } catch (error) {
    console.error('❌ Processor bootstrap failed:', error)
    process.exit(1)
  }
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

async function ensureZstdReady() {
  if (!zstdInitialized) {
    await zstdInit()
    zstdInitialized = true
    console.log('✅ [ZSTD] WASM module initialized.')
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
      await amqpChannel.assertExchange(config.RAW_DATA_EXCHANGE, 'fanout', { durable: true })
      await amqpChannel.assertQueue(config.PROCESSING_QUEUE, { durable: true })
      await amqpChannel.bindQueue(config.PROCESSING_QUEUE, config.RAW_DATA_EXCHANGE, '')
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
  amqpChannel.prefetch(1)
  const consumer = await amqpChannel.consume(config.PROCESSING_QUEUE, processMessage)
  consumerTag = consumer.consumerTag
  isConsuming = true
  console.log(`🚀 Processor service waiting for messages in queue: "${config.PROCESSING_QUEUE}"`)
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

if (import.meta.main) {
  startProcessorService().catch((error) => {
    console.error('❌ Processor service failed to start:', error)
    process.exit(1)
  })
}

function extractMetadataFromPacket(decompressedData: Buffer): {
  deviceId: string
  startTime: number
  endTime: number
} {
  if (decompressedData.length < HEADER_SIZE + POINT_SIZE) {
    throw new Error('データがヘッダーと最低1つのデータポイントを含むには短すぎます。')
  }

  const headerBuffer = decompressedData.slice(0, HEADER_SIZE)
  const nullTerminatorIndex = headerBuffer.indexOf(0)
  const deviceId = headerBuffer.toString(
    'ascii',
    0,
    nullTerminatorIndex !== -1 ? nullTerminatorIndex : undefined,
  )

  const pointsBuffer = decompressedData.slice(HEADER_SIZE)
  const numPoints = Math.floor(pointsBuffer.length / POINT_SIZE)

  if (numPoints <= 0) {
    throw new Error('パケットに有効なデータポイントが見つかりません。')
  }

  const timestampOffsetInPoint = 49
  const startTime = pointsBuffer.readUInt32LE(timestampOffsetInPoint)
  const lastPointOffset = (numPoints - 1) * POINT_SIZE
  const endTime = pointsBuffer.readUInt32LE(lastPointOffset + timestampOffsetInPoint)

  return { deviceId, startTime, endTime }
}

function isTransientError(error: any): boolean {
  if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true
  }
  if (error.code === '08006' || error.code === '08003' || error.code === '57P03') {
    return true
  }
  if (
    error.message?.includes('timeout') ||
    error.message?.includes('ECONNRESET') ||
    error.message?.includes('503')
  ) {
    return true
  }
  return false
}

async function processMessage(msg: ConsumeMessage | null) {
  if (!msg) return

  try {
    const compressedPayload = msg.content
    const userId = msg.properties?.headers?.user_id?.toString()

    if (!userId) {
      console.warn('user_idヘッダーなしでメッセージを受信しました。ACKを送信して破棄します。')
      amqpChannel?.ack(msg)
      return
    }

    const payloadView = new Uint8Array(
      compressedPayload.buffer,
      compressedPayload.byteOffset,
      compressedPayload.byteLength,
    )

    const decompressedData = zstdDecompress(payloadView)
    const decompressedBuffer = Buffer.from(decompressedData)

    const { deviceId, startTime, endTime } = extractMetadataFromPacket(decompressedBuffer)

    const objectId = `raw/${userId}/start_tick=${startTime}/end_tick=${endTime}_${uuidv4()}.zst`

    const metaData = {
      'Content-Type': 'application/octet-stream',
      'X-User-Id': userId,
      'X-Device-Id': deviceId,
      'X-Compression': 'none',
    }
    const rawBuffer = Buffer.from(decompressedBuffer)
    await minioClient.putObject(
      config.MINIO_RAW_DATA_BUCKET,
      objectId,
      rawBuffer,
      rawBuffer.length,
      metaData,
    )
    console.log(`[MinIO] アップロード成功: ${objectId}`)

    const query = `
      INSERT INTO raw_data_objects (object_id, user_id, device_id, start_time_device, end_time_device)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (object_id) DO NOTHING;
    `
    await pgPool.query(query, [objectId, userId, deviceId, startTime, endTime])
    console.log(`[PostgreSQL] メタデータ挿入成功: ${objectId}`)

    amqpChannel?.ack(msg)
  } catch (error: any) {
    console.error('❌ メッセージ処理中にエラーが発生しました:', error.message)
    if (isTransientError(error)) {
      console.warn('⚠️  一時的なエラーのため、メッセージをリキューします。')
      amqpChannel?.nack(msg, false, true)
    } else {
      console.error('🔴 恒久的なエラーのため、メッセージを破棄します。')
      amqpChannel?.nack(msg, false, false)
    }
  }
}

async function ensureMinioBucket() {
  const bucketExists = await minioClient.bucketExists(config.MINIO_RAW_DATA_BUCKET)
  if (!bucketExists) {
    console.log(`[MinIO] バケット "${config.MINIO_RAW_DATA_BUCKET}" が存在しません。作成します...`)
    await minioClient.makeBucket(config.MINIO_RAW_DATA_BUCKET)
    console.log(`✅ [MinIO] バケット "${config.MINIO_RAW_DATA_BUCKET}" を作成しました。`)
  } else {
    console.log(`✅ [MinIO] バケット "${config.MINIO_RAW_DATA_BUCKET}" はすでに存在します。`)
  }
}
