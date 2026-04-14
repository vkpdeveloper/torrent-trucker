import { Redis } from 'ioredis'
import { downloadQueue } from '../queue.ts'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const CMD_CHANNEL = (jobId: string) => `torrent:cmd:${jobId}`

export async function commandResume(args: string[]) {
  const id = args[0]

  if (!id) {
    process.stderr.write('Usage: tt resume <id>\n')
    process.exit(1)
  }

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null })
  const pub = new Redis(REDIS_URL, { maxRetriesPerRequest: null })

  const raw = await redis.hgetall(`torrent:info:${id}`)
  if (!raw || !raw.name) {
    process.stderr.write(`Error: no download found with id "${id}"\n`)
    await redis.disconnect()
    await pub.disconnect()
    process.exit(1)
  }

  const status = raw.status || 'queued'

  if (status === 'completed') {
    console.log(`Already completed: ${raw.name}`)
    await redis.disconnect()
    await pub.disconnect()
    process.exit(0)
  }

  if (status === 'queued') {
    console.log(`Already queued: ${raw.name}`)
    await redis.disconnect()
    await pub.disconnect()
    process.exit(0)
  }

  if (status === 'downloading') {
    // Job is active in BullMQ — tell the worker to destroy + re-add the torrent
    // so it re-discovers peers and verifies existing pieces.
    await pub.publish(CMD_CHANNEL(id), JSON.stringify({ action: 'restart' }))
    console.log(`Resuming:  ${raw.name}`)
    console.log(`ID:        ${id}`)
    console.log('Restart signal sent — daemon will re-verify pieces and continue.')
  } else if (status === 'paused') {
    // Torrent is intentionally paused — just unpause it
    await pub.publish(CMD_CHANNEL(id), JSON.stringify({ action: 'resume' }))
    console.log(`Resumed:   ${raw.name}`)
    console.log(`ID:        ${id}`)
  } else if (status === 'error' || status === 'stopped') {
    // Job is in BullMQ failed state — move it back to the waiting queue.
    // The worker will re-add the torrent to WebTorrent, which verifies
    // existing pieces on disk and downloads only what's missing.
    const job = await downloadQueue.getJob(id)
    if (!job) {
      process.stderr.write(`Error: job ${id} not found in BullMQ — cannot retry\n`)
      await redis.disconnect()
      await pub.disconnect()
      await downloadQueue.disconnect()
      process.exit(1)
    }

    await redis.hset(`torrent:info:${id}`, { status: 'queued', error: '' })
    await job.retry('failed')

    console.log(`Resuming:  ${raw.name}`)
    console.log(`ID:        ${id}`)
    console.log('Re-queued — daemon will verify existing pieces and continue download.')
  }

  await redis.disconnect()
  await pub.disconnect()
  await downloadQueue.disconnect()
  process.exit(0)
}
