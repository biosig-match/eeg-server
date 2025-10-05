import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { config } from '../config/env';
import { authRouter } from './routes/auth';
import { dbPool } from '../infrastructure/db';

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

// Health check helper function
async function checkDbConnection(): Promise<boolean> {
  return dbPool
    .query('SELECT 1')
    .then(() => true)
    .catch((error) => {
      console.error('❌ [AuthManager] DB health check failed:', error);
      return false;
    });
}

// Routes
app.get('/health', async (c) => {
  const dbStatus = await checkDbConnection();
  return c.json(
    { status: dbStatus ? 'ok' : 'unhealthy' },
    dbStatus ? 200 : 503,
  );
});
app.get('/', (c) => c.text('Auth Manager Service is running.'));

app.get('/api/v1/health', async (c) => {
  const dbStatus = await checkDbConnection();

  return c.json(
    {
      status: dbStatus ? 'ok' : 'degraded',
      db_connected: dbStatus,
      service: 'auth-manager',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    },
    dbStatus ? 200 : 503,
  );
});

app.route('/api/v1/auth', authRouter);

// Error Handler
app.onError((err, c) => {
  console.error(`[Hono Error] Path: ${c.req.path}`, err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

export const authManagerApp = app;

export async function startAuthManagerService() {
  console.log('🚀 Auth Manager Service starting...');
  const server = Bun.serve({
    port: config.PORT,
    fetch: app.fetch,
  });
  console.log(`🔥 Server is running on port ${server.port}`);
}

if (import.meta.main) {
  startAuthManagerService().catch((error) => {
    console.error('❌ Auth Manager bootstrap failed:', error);
    process.exit(1);
  });
}

export default {
  port: config.PORT,
  fetch: app.fetch,
};
