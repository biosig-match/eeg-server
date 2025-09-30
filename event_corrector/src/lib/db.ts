import { Pool } from 'pg';
import { config } from './config';

export const dbPool = new Pool({
  connectionString: config.DATABASE_URL,
});

dbPool.on('connect', (client) => {
  client.on('error', (err) => {
    console.error('❌ [PostgreSQL] Database client error:', err);
  });
});

dbPool.on('error', (err) => {
  console.error('❌ [PostgreSQL] Unexpected error on idle client', err);
});
