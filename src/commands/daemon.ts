import { startWorker } from '../worker.ts'

export async function commandDaemon() {
  console.log('[tt] Daemon starting...')
  startWorker()
  console.log('[tt] Daemon running. Waiting for jobs.')
  // Keep process alive indefinitely
  await new Promise(() => {})
}
