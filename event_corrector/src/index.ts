import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { eventCorrectorJobPayloadSchema } from '@/schemas/job'
import { startConsumer, isChannelReady, publishEventCorrectionJob } from '@/lib/queue'
import { ensureMinioBucket, minioClient } from '@/lib/minio'
import { dbPool } from '@/lib/db'
import { config } from '@/lib/config'

const app = new Hono()

app.get('/api/v1/health', async (c) => {
  const rabbitConnected = isChannelReady()
  const dbConnected = await dbPool
    .query('SELECT 1')
    .then(() => true)
    .catch((error) => {
      console.error('❌ [EventCorrector] DB health check failed:', error)
      return false
    })
  const minioConnected = await minioClient
    .bucketExists(config.MINIO_RAW_DATA_BUCKET)
    .then(() => true)
    .catch((error) => {
      console.error('❌ [EventCorrector] MinIO health check failed:', error)
      return false
    })

  return c.json({
    status: rabbitConnected && dbConnected && minioConnected ? 'ok' : 'degraded',
    rabbitmq_connected: rabbitConnected,
    db_connected: dbConnected,
    minio_connected: minioConnected,
    queue: config.EVENT_CORRECTION_QUEUE,
    timestamp: new Date().toISOString(),
  })
})

app.post('/api/v1/jobs', zValidator('json', eventCorrectorJobPayloadSchema), (c) => {
  if (!isChannelReady()) {
    throw new HTTPException(503, { message: 'Message broker is unavailable' })
  }
  const job = c.req.valid('json')
  publishEventCorrectionJob(job)
  return c.json({ status: 'queued' }, 202)
})

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  console.error('❌ [EventCorrector] Unhandled error:', err)
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

const port = Number(Bun.env.PORT ?? '3040')

Bun.serve({
  port,
  fetch: app.fetch,
})

console.log(`🚀 Event Corrector HTTP interface listening on port ${port}`)

void bootstrap()

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

async function bootstrap() {
  try {
    await ensureMinioBucket()
    await startConsumer()
  } catch (error) {
    console.error('❌ Event Corrector bootstrap failed:', error)
    process.exit(1)
  }
}

function gracefulShutdown(signal: NodeJS.Signals) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`)
  dbPool.end().finally(() => process.exit(0))
}
