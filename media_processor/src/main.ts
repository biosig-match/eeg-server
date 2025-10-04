import { startMediaProcessorService } from './app/server'

startMediaProcessorService().catch((error) => {
  console.error('❌ Media Processor service failed to start:', error)
  process.exit(1)
})
