import { startConsumer } from '@/lib/queue';
import { dbPool } from './lib/db';
import { ensureMinioBucket } from './lib/minio';

console.log('🚀 Event Corrector Service starting...');

async function main() {
  try {
    // 起動時に依存サービスへの接続を確認
    await dbPool.query('SELECT 1');
    console.log('✅ [PostgreSQL] Database connection successful.');

    // MinIOバケットの存在を確認し、なければ作成する
    await ensureMinioBucket();

    // 全ての接続が成功したらコンシューマを開始
    await startConsumer();
  } catch (error) {
    console.error('❌ Failed to initialize service dependencies. Shutting down.', error);
    process.exit(1);
  }
}

main();
