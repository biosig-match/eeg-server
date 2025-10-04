import { startAuthManagerService } from './app/server';

startAuthManagerService().catch((error) => {
  console.error('❌ Auth Manager service failed to start:', error);
  process.exit(1);
});
