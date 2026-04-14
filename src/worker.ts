import { Worker, type Job } from 'bullmq'
import WebTorrent from 'webtorrent'
import { Redis } from 'ioredis'
import { pub, cmdSub, cmdEmitter, CMD_CHANNEL, UPDATES_CHANNEL } from './redis.ts'
import { mkdirSync } from 'fs'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads'

// How long (ms) with zero new bytes before we auto-restart the torrent
const STALL_TIMEOUT_MS = parseInt(process.env.STALL_TIMEOUT_MS || '60000')
// How often (ms) the stall watchdog checks for progress
const STALL_CHECK_MS = 15_000

mkdirSync(DOWNLOAD_DIR, { recursive: true })

const client = new WebTorrent({
  maxConns: 200,     // default 55 — more peers = faster downloads
  dht: true,
  lsd: true,
  utp: true,
  downloadLimit: -1, // unlimited
  uploadLimit: -1,   // unlimited
})

client.on('error', (err) => console.error('[WebTorrent]', err))

async function publishUpdate(update: object) {
  await pub.publish(UPDATES_CHANNEL, JSON.stringify(update))
}

export function startWorker() {
  const workerRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null })

  const worker = new Worker(
    'torrent-downloads',
    async (job: Job) => {
      const { torrentKey, magnetLink, name: initialName } = job.data as {
        torrentKey?: string
        magnetLink?: string
        name: string
      }

      let torrentSource: Buffer | string
      if (magnetLink) {
        torrentSource = magnetLink
      } else if (torrentKey) {
        const buf = await workerRedis.getBuffer(torrentKey)
        if (!buf) throw new Error('Torrent data not found in Redis')
        torrentSource = buf
      } else {
        throw new Error('Job has neither torrentKey nor magnetLink')
      }

      const cmdChannel = CMD_CHANNEL(job.id!)
      await cmdSub.subscribe(cmdChannel)

      return new Promise<void>((resolve, reject) => {
        // Rolling 30-second speed window for stable ETA
        const WINDOW_MS = 30_000
        let speedSamples: Array<{ bytes: number; ts: number }> = []

        // Stall watchdog state
        let isReady = false
        let lastDownloaded = 0
        let lastProgressAt = Date.now()

        // Current active torrent — replaced on restart
        let currentTorrent = client.add(torrentSource as any, { path: DOWNLOAD_DIR, maxWebConns: 100 })

        function rollingEtaMs(): number {
          const downloaded = currentTorrent.downloaded
          const now = Date.now()
          speedSamples.push({ bytes: downloaded, ts: now })
          // Drop samples outside the window
          while (speedSamples.length > 1 && speedSamples[0].ts < now - WINDOW_MS) {
            speedSamples.shift()
          }
          if (speedSamples.length < 2) return -1
          const oldest = speedSamples[0]
          const elapsed = (now - oldest.ts) / 1000
          const bytesDelta = downloaded - oldest.bytes
          if (elapsed <= 0 || bytesDelta <= 0) return -1
          const avgSpeed = bytesDelta / elapsed // bytes/sec
          const remaining = currentTorrent.length - downloaded
          return remaining <= 0 ? 0 : Math.round((remaining / avgSpeed) * 1000)
        }

        // Stall watchdog: fires every STALL_CHECK_MS, restarts torrent if stalled
        const stallTimer = setInterval(async () => {
          if (!isReady) return
          if ((currentTorrent as any).destroyed) return
          if ((currentTorrent as any).paused) return

          const nowBytes = currentTorrent.downloaded
          if (nowBytes > lastDownloaded) {
            // Progress made — reset tracker
            lastDownloaded = nowBytes
            lastProgressAt = Date.now()
          } else if (Date.now() - lastProgressAt >= STALL_TIMEOUT_MS) {
            const stalledSec = Math.round((Date.now() - lastProgressAt) / 1000)
            console.log(`[Worker] Job ${job.id} stalled for ${stalledSec}s — auto-resuming`)
            await workerRedis.hset(`torrent:info:${job.id}`, { status: 'downloading' })
            await publishUpdate({ jobId: job.id, type: 'status', data: { status: 'downloading' } })
            restartTorrent()
          }
        }, STALL_CHECK_MS)

        const cleanup = () => {
          clearInterval(stallTimer)
          cmdEmitter.off(cmdChannel, cmdHandler)
          cmdSub.unsubscribe(cmdChannel)
          if (!(currentTorrent as any).destroyed) currentTorrent.destroy()
        }

        // Destroy the current torrent and re-add it so WebTorrent verifies
        // existing pieces on disk and resumes from the furthest valid piece.
        function restartTorrent() {
          speedSamples = []
          isReady = false
          if (!(currentTorrent as any).destroyed) currentTorrent.destroy()
          currentTorrent = client.add(torrentSource as any, { path: DOWNLOAD_DIR, maxWebConns: 100 })
          // Re-attach event handlers to the new Torrent object
          attachHandlers()
        }

        function attachHandlers() {
          currentTorrent.on('ready', async () => {
            const name = currentTorrent.name || initialName || 'Unknown'
            // Progress may be > 0 if we're resuming a partial download
            const progress = Math.round(currentTorrent.progress * 1000) / 10
            await workerRedis.hset(`torrent:info:${job.id}`, {
              name,
              size: currentTorrent.length.toString(),
              status: 'downloading',
              progress: progress.toString(),
              downloadSpeed: '0',
              uploadSpeed: '0',
              numPeers: '0',
              eta: '-1',
              files: JSON.stringify(currentTorrent.files.map((f) => ({ name: f.name, size: f.length }))),
            })
            await publishUpdate({
              jobId: job.id,
              type: 'ready',
              data: {
                name,
                size: currentTorrent.length,
                status: 'downloading',
                progress,
              },
            })
            // Enable stall watchdog now that we're in an active download
            isReady = true
            lastDownloaded = currentTorrent.downloaded
            lastProgressAt = Date.now()
          })

          currentTorrent.on('download', async () => {
            const progress = Math.round(currentTorrent.progress * 1000) / 10
            const eta = rollingEtaMs()
            const update = {
              progress,
              downloadSpeed: Math.round(currentTorrent.downloadSpeed),
              numPeers: currentTorrent.numPeers,
              eta,
              status: 'downloading',
            }
            await workerRedis.hset(`torrent:info:${job.id}`, {
              progress: progress.toString(),
              downloadSpeed: update.downloadSpeed.toString(),
              numPeers: update.numPeers.toString(),
              eta: eta.toString(),
            })
            await publishUpdate({ jobId: job.id, type: 'progress', data: update })
          })

          currentTorrent.on('done', async () => {
            await workerRedis.hset(`torrent:info:${job.id}`, {
              status: 'completed',
              progress: '100',
              downloadSpeed: '0',
              eta: '0',
            })
            await publishUpdate({
              jobId: job.id,
              type: 'completed',
              data: { status: 'completed', progress: 100 },
            })
            cleanup()
            if (torrentKey) await workerRedis.del(torrentKey as string)
            resolve()
          })

          currentTorrent.on('error', async (err: unknown) => {
            const message = err instanceof Error ? err.message : 'Unknown error'
            await workerRedis.hset(`torrent:info:${job.id}`, {
              status: 'error',
              error: message,
            })
            await publishUpdate({ jobId: job.id, type: 'error', data: { error: message } })
            cleanup()
            reject(err instanceof Error ? err : new Error(message))
          })
        }

        const cmdHandler = async (message: string) => {
          try {
            const { action } = JSON.parse(message) as { action: string }

            if (action === 'pause') {
              currentTorrent.pause()
              await workerRedis.hset(`torrent:info:${job.id}`, { status: 'paused' })
              await publishUpdate({ jobId: job.id, type: 'status', data: { status: 'paused' } })
            } else if (action === 'resume') {
              currentTorrent.resume()
              await workerRedis.hset(`torrent:info:${job.id}`, { status: 'downloading' })
              await publishUpdate({ jobId: job.id, type: 'status', data: { status: 'downloading' } })
            } else if (action === 'restart') {
              // Full torrent restart: destroy + re-add so WebTorrent re-discovers
              // peers and verifies existing pieces on disk before continuing.
              console.log(`[Worker] Restart requested for job ${job.id}`)
              await workerRedis.hset(`torrent:info:${job.id}`, { status: 'downloading' })
              await publishUpdate({ jobId: job.id, type: 'status', data: { status: 'downloading' } })
              restartTorrent()
            } else if (action === 'stop') {
              await workerRedis.hset(`torrent:info:${job.id}`, { status: 'stopped' })
              await publishUpdate({ jobId: job.id, type: 'status', data: { status: 'stopped' } })
              cleanup()
              reject(new Error('Stopped by user'))
            }
          } catch (e) {
            console.error('[Worker] Command handler error:', e)
          }
        }

        cmdEmitter.on(cmdChannel, cmdHandler)
        // Attach handlers to the initial torrent
        attachHandlers()
      })
    },
    {
      connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
      concurrency: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3'),
    },
  )

  worker.on('failed', (job, err) => {
    if (err?.message !== 'Stopped by user') {
      console.error(`[Worker] Job ${job?.id} failed:`, err?.message)
    }
  })

  worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed`)
  })

  console.log('[Worker] Started — listening for download jobs')
  return worker
}
