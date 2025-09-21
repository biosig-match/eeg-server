import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';

import { experimentsRouter } from './routes/experiments';
import { sessionsRouter } from './routes/sessions';
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
app.route('/api/v1/experiments', experimentsRouter);
app.route('/api/v1/sessions', sessionsRouter);

app.onError((err, c) => {
  console.error(`[Hono Error] Path: ${c.req.path}`, err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

console.log('🚀 Session Manager Service starting...');

initializeQueue()
  .then(() => {
    console.log('✅ [RabbitMQ] Connection established and channel is ready.');
    console.log(`🔥 Server is running on port ${config.PORT}`);
  })
  .catch((err) => {
    console.error('❌ Failed to connect to RabbitMQ on startup. The service will run but cannot queue tasks.', err);
  });

export default {
  port: config.PORT,
  fetch: app.fetch,
};
