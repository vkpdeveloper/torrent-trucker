import { startWorker } from './worker.ts'
import { startServer } from './server.ts'

const PORT = parseInt(process.env.PORT || '3000')

startWorker()
startServer(PORT)

console.log(`\n🚛  Torrent Trucker running → http://localhost:${PORT}\n`)
