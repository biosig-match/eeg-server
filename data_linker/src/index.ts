import { startConsumer } from './lib/queue';

console.log('🚀 DataLinker Service starting...');

startConsumer();

function gracefulShutdown(signal: string) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  // Here you would close DB connections, RabbitMQ connections, etc.
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
