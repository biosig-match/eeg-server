import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { config } from './lib/config';
import { authRouter } from './routes/auth';

const app = new Hono();

// Middlewares
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

// Routes
app.get('/', (c) => c.text('Auth Manager Service is running.'));
app.route('/api/v1/auth', authRouter);

// Error Handler
app.onError((err, c) => {
  console.error(`[Hono Error] Path: ${c.req.path}`, err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

console.log('🚀 Auth Manager Service starting...');
console.log(`🔥 Server is running on port ${config.PORT}`);

export default {
  port: config.PORT,
  fetch: app.fetch,
};
