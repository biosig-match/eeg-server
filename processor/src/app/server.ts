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

app.get('/health', async (c) => {
  const rabbitStatus = (() => {
    if (!amqpChannel) {
      console.error('❌ [Processor] RabbitMQ health check failed: channel not available')
      return false
    }
    return true
  })()
  const dbStatus = await pgPool
    .query('SELECT 1')
    .then(() => true)
    .catch((error) => {
      console.error('❌ [Processor] DB health check failed:', error)
      return false
    })
  const allOk = rabbitStatus && dbStatus
  return c.json(
    { status: allOk ? 'ok' : 'unhealthy' },
    allOk ? 200 : 503,
  )
})

const inspectSchema = z.object({
  payload_base64: z.string().min(1, 'payload_base64 is required'),
  sampling_rate: z.number().positive('sampling_rate is required and must be positive'),
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
  const { payload_base64, sampling_rate } = c.req.valid('json')
  let payload: Buffer
  try {
    payload = Buffer.from(payload_base64, 'base64')
  } catch (error) {
    throw new HTTPException(400, { message: 'payload_base64 must be valid base64', cause: error })
  }

  const payloadView = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  const decompressedData = zstdDecompress(payloadView)
  const decompressedBuffer = Buffer.from(decompressedData)
  const inspectionResult = inspectBinaryPayload(decompressedBuffer, sampling_rate)

  return c.json({
    inspection_result: inspectionResult,
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

function inspectBinaryPayload(data: Buffer, sampling_rate: number): Record<string, any> {
  try {
    if (data.length < 4) { // version(1) + num_channels(1) + reserved(2)
      throw new Error('Data is too short for a valid header.')
    }

    let offset = 0
    const version = data.readUInt8(offset); offset += 1
    if (version !== 0x04) {
      throw new Error(`Unsupported payload version: ${version}. Expected 4.`)
    }
    const num_channels = data.readUInt8(offset); offset += 1
    offset += 2 // Skip reserved bytes

    const electrodeConfigHeaderSize = offset + (num_channels * 10)
    if (data.length < electrodeConfigHeaderSize) {
      throw new Error(`Data is too short for electrode config. Expected: ${electrodeConfigHeaderSize}, Actual: ${data.length}`)
    }
    
    const electrode_config = []
    for (let i = 0; i < num_channels; i++) {
      const nameBuffer = data.slice(offset, offset + 8)
      const name = nameBuffer.toString('utf-8').replace(/\0/g, '')
      offset += 8
      const type = data.readUInt8(offset)
      offset += 1
      offset += 1 // Skip reserved byte for electrode_config
      electrode_config.push({ name, type })
    }

    const headerSize = offset
    const samplesPayload = data.slice(headerSize)
    // 1サンプルあたりのサイズ: signals(ch*2) + accel(6) + gyro(6) + impedance(ch*1)
    const sampleSize = (num_channels * 2) + 6 + 6 + num_channels

    if (sampleSize === 0) {
      return {
        header: { version, num_channels, electrode_config },
        error: 'Sample size is zero, cannot determine sample count.',
      }
    }

    const num_samples_found = Math.floor(samplesPayload.length / sampleSize)

    return {
      header: {
        version,
        num_channels,
        electrode_config,
      },
      payload_info: {
        header_size_bytes: headerSize,
        sample_size_bytes: sampleSize,
        num_samples_found: num_samples_found,
        expected_samples: sampling_rate,
      },
    }
  } catch (error: any) {
    return { error: 'Failed to inspect binary payload', details: error.message }
  }
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

  const ack = () => amqpChannel?.ack(msg)
  const nack = (requeue = false) => amqpChannel?.nack(msg, false, requeue)

  try {
    const { headers } = msg.properties
    const userId = headers?.user_id?.toString()
    const deviceId = headers?.device_id?.toString()
    const sessionId = headers?.session_id?.toString()
    const startTimeMs = headers?.timestamp_start_ms
    const endTimeMs = headers?.timestamp_end_ms
    const samplingRate = headers?.sampling_rate
    const lsbToVolts = headers?.lsb_to_volts

    if (!userId || !deviceId || startTimeMs === undefined || endTimeMs === undefined || samplingRate === undefined || lsbToVolts === undefined) {
      console.warn(
        '必要なヘッダー(user_id, device_id, timestamps, sampling_rate, lsb_to_volts)が不足しているため、メッセージを破棄します。',
        headers,
      )
      ack()
      return
    }

    const compressedPayload = msg.content
    const payloadView = new Uint8Array(
      compressedPayload.buffer,
      compressedPayload.byteOffset,
      compressedPayload.byteLength,
    )

    const decompressedData = zstdDecompress(payloadView)
    const decompressedBuffer = Buffer.from(decompressedData)

    const objectId = `raw/${userId}/${deviceId}/start_ms=${startTimeMs}/end_ms=${endTimeMs}_${uuidv4()}.bin`

    const metaData = {
      'Content-Type': 'application/octet-stream',
      'X-User-Id': userId,
      'X-Device-Id': deviceId,
      'X-Sampling-Rate': String(samplingRate),
      'X-Lsb-To-Volts': String(lsbToVolts),
      ...(sessionId && { 'X-Session-Id': sessionId }),
    }

    await minioClient.putObject(
      config.MINIO_RAW_DATA_BUCKET,
      objectId,
      decompressedBuffer,
      decompressedBuffer.length,
      metaData,
    )
    console.log(`[MinIO] アップロード成功: ${objectId}`)

    const query = `
      INSERT INTO raw_data_objects (object_id, user_id, device_id, session_id, timestamp_start_ms, timestamp_end_ms, sampling_rate, lsb_to_volts)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (object_id) DO NOTHING
    `
    await pgPool.query(query, [
      objectId,
      userId,
      deviceId,
      null, // Session linking is handled asynchronously by DataLinker
      startTimeMs,
      endTimeMs,
      samplingRate,
      lsbToVolts,
    ])
    console.log(`[PostgreSQL] メタデータ挿入成功: ${objectId}`)

    ack()
  } catch (error: any) {
    console.error('❌ メッセージ処理中にエラーが発生しました:', error.message)
    if (isTransientError(error)) {
      console.warn('⚠️  一時的なエラーのため、メッセージをリキューします。')
      nack(true)
    } else {
      console.error('🔴 恒久的なエラーのため、メッセージを破棄します。')
      nack(false)
    }
  }
}

async function ensureMinioBucket(maxAttempts = 5, baseDelayMs = 1_000) {
  let attempt = 0
  while (attempt < maxAttempts) {
    attempt += 1
    try {
      const bucketExists = await minioClient.bucketExists(config.MINIO_RAW_DATA_BUCKET)
      if (!bucketExists) {
        console.log(
          `[MinIO] バケット "${config.MINIO_RAW_DATA_BUCKET}" が存在しません。作成します...`,
        )
        await minioClient.makeBucket(config.MINIO_RAW_DATA_BUCKET)
        console.log(`✅ [MinIO] バケット "${config.MINIO_RAW_DATA_BUCKET}" を作成しました。`)
      } else {
        console.log(`✅ [MinIO] バケット "${config.MINIO_RAW_DATA_BUCKET}" はすでに存在します。`)
      }
      return
    } catch (error) {
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 10_000)
      console.error(
        `❌ [MinIO] バケット初期化に失敗しました (attempt ${attempt}/${maxAttempts}).`,
        error,
      )
      if (attempt >= maxAttempts) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
