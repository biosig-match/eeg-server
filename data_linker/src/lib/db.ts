import { Pool } from 'pg';
import { config } from './config';

export const dbPool = new Pool({
  connectionString: config.DATABASE_URL,
});

dbPool.on('connect', () => {
  console.log('✅ [PostgreSQL] Connected to the database.');
});

dbPool.on('error', (err) => {
  console.error('❌ [PostgreSQL] Unexpected error on idle client', err);
  process.exit(-1);
});
