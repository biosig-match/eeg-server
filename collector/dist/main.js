import { startCollectorService } from './app/server';
startCollectorService().catch((error) => {
    console.error('❌ Collector service failed to start:', error);
    process.exit(1);
});
