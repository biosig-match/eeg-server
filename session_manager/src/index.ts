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
import { initializeQueue } from './lib/queue';
import { config } from './lib/config';

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

initializeQueue()
  .then(() => {
    console.log('✅ [RabbitMQ] Initial connection established and channel is ready.');
  })
  .catch((err) => {
    console.error(
      '❌ [RabbitMQ] Failed to connect on startup. The service will run but cannot queue tasks.',
      err,
    );
  });

console.log(`🔥 Server is running on port ${config.PORT}`);

export default server;
