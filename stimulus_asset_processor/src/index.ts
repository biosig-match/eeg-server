import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { dbPool } from './lib/db'
import { ensureMinioBucket, minioClient } from './lib/minio'
import {
  startConsumer,
  isChannelReady,
  lastRabbitConnection,
  publishStimulusAssetJob,
} from './lib/queue'
import { stimulusAssetJobPayloadSchema } from './schemas/job'
import { config } from './lib/config'

const app = new Hono()

app.get('/api/v1/health', async (c) => {
  const rabbitConnected = isChannelReady()
  const dbConnected = await dbPool
    .query('SELECT 1')
    .then(() => true)
    .catch((error) => {
      console.error('❌ [StimulusAssetProcessor] DB health check failed:', error)
      return false
    })
  const minioConnected = await minioClient
    .bucketExists(config.MINIO_MEDIA_BUCKET)
    .then(() => true)
    .catch((error) => {
      console.error('❌ [StimulusAssetProcessor] MinIO health check failed:', error)
      return false
    })

  return c.json({
    status: rabbitConnected && dbConnected && minioConnected ? 'ok' : 'degraded',
    rabbitmq_connected: rabbitConnected,
    db_connected: dbConnected,
    minio_connected: minioConnected,
    queue: config.STIMULUS_ASSET_QUEUE,
    last_rabbit_connected_at: lastRabbitConnection()?.toISOString() ?? null,
    timestamp: new Date().toISOString(),
  })
})

app.post('/api/v1/jobs', zValidator('json', stimulusAssetJobPayloadSchema), (c) => {
  if (!isChannelReady()) {
    throw new HTTPException(503, { message: 'Message broker is unavailable' })
  }
  const job = c.req.valid('json')
  publishStimulusAssetJob(job)
  return c.json({ status: 'queued' }, 202)
})

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  console.error('❌ [StimulusAssetProcessor] Unhandled error:', err)
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

const port = Number(Bun.env.PORT ?? '3050')

Bun.serve({
  port,
  fetch: app.fetch,
})

console.log(`🚀 Stimulus Asset Processor HTTP interface listening on port ${port}`)

void bootstrap()

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

async function bootstrap() {
  try {
    await ensureMinioBucket()
    await startConsumer()
  } catch (error) {
    console.error('❌ Stimulus Asset Processor bootstrap failed:', error)
    process.exit(1)
  }
}

function gracefulShutdown(signal: NodeJS.Signals) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`)
  dbPool.end().finally(() => process.exit(0))
}
