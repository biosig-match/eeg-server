import { startStimulusAssetProcessorService } from './app/server'

startStimulusAssetProcessorService().catch((error) => {
  console.error('❌ Stimulus Asset Processor service failed to start:', error)
  process.exit(1)
})
