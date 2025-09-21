import { startConsumer } from './lib/queue';

console.log('🚀 Stimulus Asset Processor Service starting...');

startConsumer();

process.on('uncaughtException', (error) => {
  console.error('Unhandled Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
