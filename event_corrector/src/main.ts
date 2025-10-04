import { startEventCorrectorService } from './app/server'

startEventCorrectorService().catch((error) => {
  console.error('❌ Event Corrector service failed to start:', error)
  process.exit(1)
})
