import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';

import { experimentsRouter } from './routes/experiments';
import { sessionsRouter } from './routes/sessions';
import { calibrationsRouter } from './routes/calibrations';
// ### <<< 修正点 >>> ###
// 新しく作成した stimuliRouter をインポート
import { stimuliRouter } from './routes/stimuli';
import {
  initializeQueue,
  isQueueReady,
  getLastRabbitConnection,
  shutdownQueue,
} from './lib/queue';
import { config } from './lib/config';
import { dbPool } from './lib/db';

const app = new Hono();

app.use('*', logger());
app.use('*', secureHeaders());
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

app.get('/', (c) => c.text('Session Manager Service is running.'));

app.get('/api/v1/health', async (c) => {
  const rabbitReady = isQueueReady();
  const dbReady = await dbPool
    .query('SELECT 1')
    .then(() => true)
    .catch((error) => {
      console.error('❌ [SessionManager] DB health check failed:', error);
      return false;
    });

  const statusOk = rabbitReady && dbReady;
  return c.json(
    {
      status: statusOk ? 'ok' : 'degraded',
      rabbitmq_connected: rabbitReady,
      db_connected: dbReady,
      last_rabbit_connected_at: getLastRabbitConnection()?.toISOString() ?? null,
      timestamp: new Date().toISOString(),
    },
    statusOk ? 200 : 503,
  );
});

// --- API Routes ---
app.route('/api/v1/experiments', experimentsRouter);
app.route('/api/v1/sessions', sessionsRouter);
app.route('/api/v1/calibrations', calibrationsRouter);
// ### <<< 修正点 >>> ###
// 新しいAPIエンドポイントを登録
app.route('/api/v1/stimuli', stimuliRouter);

app.onError((err, c) => {
  console.error(`[Hono Error] Path: ${c.req.path}`, err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

console.log('🚀 Session Manager Service starting...');

const server = {
  port: config.PORT,
  fetch: app.fetch,
};

initializeQueue().then(() => {
  console.log('✅ [RabbitMQ] Initial connection established and channel is ready.');
});

console.log(`🔥 Server is running on port ${config.PORT}`);

process.on('SIGINT', (signal) => {
  void shutdown(signal);
});
process.on('SIGTERM', (signal) => {
  void shutdown(signal);
});

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

export default server;
