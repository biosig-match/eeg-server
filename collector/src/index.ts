import amqp, { Channel, Connection } from 'amqplib'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'

const {
  RABBITMQ_URL = 'amqp://guest:guest@rabbitmq',
  RAW_DATA_EXCHANGE = 'raw_data_exchange',
  MEDIA_PROCESSING_QUEUE = 'media_processing_queue',
  PORT = '3000',
} = Bun.env

let amqpConnection: Connection | null = null
let amqpChannel: Channel | null = null
let lastConnectedAt: Date | null = null

const app = new Hono()

const dataSchema = z.object({
  user_id: z.string().min(1, 'user_id is required'),
  payload_base64: z.string().min(1, 'payload_base64 is required'),
})

const mediaSchema = z
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
    const isImage = value.mimetype.startsWith('image')
    if (isImage && !value.timestamp_utc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'timestamp_utc is required for image uploads',
        path: ['timestamp_utc'],
      })
    }
    if (!isImage && (!value.start_time_utc || !value.end_time_utc)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'start_time_utc and end_time_utc are required for audio uploads',
        path: ['start_time_utc'],
      })
    }
  })

async function setupChannel() {
  if (!amqpConnection) return
  amqpChannel = await amqpConnection.createChannel()
  await amqpChannel.assertExchange(RAW_DATA_EXCHANGE, 'fanout', { durable: true })
  await amqpChannel.assertQueue(MEDIA_PROCESSING_QUEUE, { durable: true })
  console.log('✅ [RabbitMQ] Channel ready.')
}

async function connectRabbitMQ() {
  let attempt = 0
  while (!amqpChannel) {
    try {
      attempt += 1
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
      await setupChannel()
      lastConnectedAt = new Date()
      console.log('✅ [RabbitMQ] Connected.')
      break
    } catch (error) {
      console.error('❌ [RabbitMQ] Connection attempt failed:', error)
      const backoff = Math.min(30000, 2 ** attempt * 1000)
      await new Promise((resolve) => setTimeout(resolve, backoff))
    }
  }
}

function assertChannelOrThrow() {
  if (!amqpChannel) {
    throw new HTTPException(503, {
      message: 'Message broker is unavailable',
    })
  }
}

app.get('/api/v1/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'collector-service',
    rabbitmq_connected: !!amqpChannel,
    last_connected_at: lastConnectedAt?.toISOString() ?? null,
    timestamp: new Date().toISOString(),
  })
})

app.post('/api/v1/data', zValidator('json', dataSchema), async (c) => {
  assertChannelOrThrow()
  const { user_id, payload_base64 } = c.req.valid('json')

  let binaryPayload: Buffer
  try {
    binaryPayload = Buffer.from(payload_base64, 'base64')
    if (!binaryPayload.length && payload_base64.length) {
      throw new Error('Decoded payload is empty')
    }
  } catch (error) {
    throw new HTTPException(400, { message: 'payload_base64 must be valid base64', cause: error })
  }

  amqpChannel!.publish(RAW_DATA_EXCHANGE, '', binaryPayload, {
    persistent: true,
    headers: { user_id },
    timestamp: Date.now(),
    contentType: 'application/octet-stream',
    contentEncoding: 'zstd',
  })

  console.log(
    `[HTTP:/data] Published sensor data for user: ${user_id} (${binaryPayload.byteLength} bytes)`,
  )
  return c.json({ status: 'accepted' }, 202)
})

app.post('/api/v1/media', async (c) => {
  assertChannelOrThrow()
  const form = await c.req.parseBody()
  const file = form['file']
  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: '`file` field is required' })
  }

  const { file: _ignored, ...rawMetadata } = form
  const parseResult = mediaSchema.safeParse(rawMetadata)
  if (!parseResult.success) {
    throw new HTTPException(400, { cause: parseResult.error, message: 'Invalid metadata' })
  }
  const metadata = parseResult.data

  const fileBuffer = Buffer.from(await file.arrayBuffer())
  const headers = {
    user_id: metadata.user_id,
    session_id: metadata.session_id,
    mimetype: metadata.mimetype,
    original_filename: metadata.original_filename,
    ...(metadata.timestamp_utc ? { timestamp_utc: metadata.timestamp_utc } : {}),
    ...(metadata.start_time_utc ? { start_time_utc: metadata.start_time_utc } : {}),
    ...(metadata.end_time_utc ? { end_time_utc: metadata.end_time_utc } : {}),
  }

  amqpChannel!.sendToQueue(MEDIA_PROCESSING_QUEUE, fileBuffer, {
    persistent: true,
    headers,
    timestamp: Date.now(),
    contentType: metadata.mimetype,
  })

  console.log(
    `[HTTP:/media] Queued media file for user: ${metadata.user_id}, session: ${metadata.session_id} (${fileBuffer.byteLength} bytes)`,
  )
  return c.json({ status: 'accepted' }, 202)
})

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const response = err.getResponse()
    return response
  }
  console.error('❌ [Collector] Unhandled error:', err)
  return c.json({ error: 'Internal Server Error' }, 500)
})

type NotFound = { message: string }
app.notFound((c) => {
  const payload: NotFound = {
    message: `The requested endpoint ${c.req.method} ${c.req.path} does not exist.`,
  }
  return c.json(payload, 404)
})

Bun.serve({
  port: Number(PORT),
  fetch: app.fetch,
})

connectRabbitMQ().catch((error) => {
  console.error('❌ [RabbitMQ] Initial connection failed:', error)
})

console.log(`🚀 Collector service is running on port ${PORT}`)
