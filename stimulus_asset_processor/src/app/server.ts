import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { dbPool } from '../infrastructure/db'
import { ensureMinioBucket, minioClient } from '../infrastructure/minio'
import {
  startConsumer,
  isChannelReady,
  lastRabbitConnection,
  publishStimulusAssetJob,
  shutdownQueue,
} from '../infrastructure/queue'
import { stimulusAssetJobPayloadSchema } from './schemas/job'
import { config } from '../config/env'

const app = new Hono()

app.get('/health', async (c) => {
  const rabbitConnected = isChannelReady();
  const dbConnected = await dbPool.query('SELECT 1').then(() => true).catch(() => false);
  const minioConnected = await minioClient.bucketExists(config.MINIO_MEDIA_BUCKET).then(() => true).catch(() => false);
  const allOk = rabbitConnected && dbConnected && minioConnected;
  return c.json(
    { status: allOk ? 'ok' : 'unhealthy' },
    allOk ? 200 : 503,
  );
})

app.get('/api/v1/health', async (c) => {
  const rabbitConnected = isChannelReady();
  const dbConnected = await dbPool
    .query('SELECT 1')
    .then(() => true)
    .catch((error) => {
      console.error('❌ [StimulusAssetProcessor] DB health check failed:', error);
      return false;
    });
  const minioConnected = await minioClient
    .bucketExists(config.MINIO_MEDIA_BUCKET)
    .then(() => true)
    .catch((error) => {
      console.error('❌ [StimulusAssetProcessor] MinIO health check failed:', error);
      return false;
    });

  return c.json(
    {
      status: rabbitConnected && dbConnected && minioConnected ? 'ok' : 'degraded',
      rabbitmq_connected: rabbitConnected,
      db_connected: dbConnected,
      minio_connected: minioConnected,
      queue: config.STIMULUS_ASSET_QUEUE,
      last_rabbit_connected_at: lastRabbitConnection()?.toISOString() ?? null,
      timestamp: new Date().toISOString(),
    },
    rabbitConnected && dbConnected && minioConnected ? 200 : 503,
  );
});

app.post('/api/v1/jobs', zValidator('json', stimulusAssetJobPayloadSchema), (c) => {
  if (!isChannelReady()) {
    throw new HTTPException(503, { message: 'Message broker is unavailable' })
  }
  const job = c.req.valid('json');
  publishStimulusAssetJob(job);
  return c.json({ status: 'queued' }, 202);
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

export const stimulusAssetProcessorApp = app

export async function startStimulusAssetProcessorService() {
  const server = Bun.serve({
    port: config.PORT,
    fetch: app.fetch,
  })

  console.log(`🚀 Stimulus Asset Processor HTTP interface listening on port ${server.port}`)

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
    await ensureMinioBucket();
    await startConsumer();
  } catch (error) {
    console.error('❌ Stimulus Asset Processor bootstrap failed:', error)
    process.exit(1)
  }
}

async function shutdown(signal: NodeJS.Signals) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  try {
    await shutdownQueue();
    await dbPool.end();
    console.log('✅ Graceful shutdown completed');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  } finally {
    process.exit(0);
  }
}

if (import.meta.main) {
  startStimulusAssetProcessorService().catch((error) => {
    console.error('❌ Stimulus Asset Processor service failed to start:', error)
    process.exit(1)
  })
}
