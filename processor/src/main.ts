import { startProcessorService } from './app/server'

startProcessorService().catch((error) => {
  console.error('❌ Processor service failed to start:', error)
  process.exit(1)
})
