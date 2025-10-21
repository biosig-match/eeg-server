import { startObservabilityService } from './app/server'

startObservabilityService().catch((error) => {
  console.error('❌ Observability dashboard failed to start:', error)
  process.exit(1)
})
