import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { dataLinkerJobPayloadSchema } from './schemas/job'
import { startConsumer, getAmqpChannel } from './lib/queue'
import { dbPool } from './lib/db'
import { config } from './lib/config'

const app = new Hono()

app.get('/api/v1/health', async (c) => {
  const rabbitConnected = (() => {
    try {
      const channel = getAmqpChannel()
      return !!channel
    } catch (error) {
      return false
    }
  })()

  const dbConnected = await dbPool
    .query('SELECT 1')
    .then(() => true)
    .catch((error) => {
      console.error('❌ [DataLinker] DB health check failed:', error)
      return false
    })

  return c.json({
    status: rabbitConnected && dbConnected ? 'ok' : 'degraded',
    rabbitmq_connected: rabbitConnected,
    db_connected: dbConnected,
    queue: config.DATA_LINKER_QUEUE,
    timestamp: new Date().toISOString(),
  })
})

app.post('/api/v1/jobs', zValidator('json', dataLinkerJobPayloadSchema), async (c) => {
  try {
    const channel = getAmqpChannel()
    const jobPayload = c.req.valid('json')
    channel.sendToQueue(
      config.DATA_LINKER_QUEUE,
      Buffer.from(JSON.stringify(jobPayload)),
      { persistent: true },
    )
    return c.json({ status: 'queued' }, 202)
  } catch (error) {
    console.error('❌ [DataLinker] Failed to enqueue job:', error)
    throw new HTTPException(503, { message: 'Message broker is unavailable', cause: error })
  }
})

app.notFound((c) =>
  c.json(
    {
      message: `The requested endpoint ${c.req.method} ${c.req.path} does not exist.`,
    },
    404,
  ),
)

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  console.error('❌ [DataLinker] Unhandled error:', err)
  return c.json({ error: 'Internal Server Error' }, 500)
})

const port = Number(Bun.env.PORT ?? '3030')

Bun.serve({
  port,
  fetch: app.fetch,
})

console.log(`🚀 DataLinker HTTP interface listening on port ${port}`)

void startConsumer()

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

function gracefulShutdown(signal: NodeJS.Signals) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`)
  dbPool.end().finally(() => process.exit(0))
}
