import { startSessionManagerService } from './app/server';

startSessionManagerService().catch((error) => {
  console.error('❌ Session Manager service failed to start:', error);
  process.exit(1);
});
