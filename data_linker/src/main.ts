import { startDataLinkerService } from './app/server'

startDataLinkerService().catch((error) => {
  console.error('❌ Data Linker service failed to start:', error)
  process.exit(1)
})
