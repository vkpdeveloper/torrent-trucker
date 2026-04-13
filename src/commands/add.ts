import { downloadQueue } from '../queue.ts'
import { Redis } from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

export async function commandAdd(args: string[]) {
  const magnet = args[0]

  if (!magnet) {
    process.stderr.write('Usage: tt add <magnet-link>\n')
    process.exit(1)
  }

  if (!magnet.startsWith('magnet:')) {
    process.stderr.write('Error: argument must be a magnet link (starts with "magnet:")\n')
    process.exit(1)
  }

  // Extract display name from dn= param
  let name = 'Unknown'
  try {
    const dn = new URL(magnet).searchParams.get('dn')
    if (dn) name = decodeURIComponent(dn)
  } catch {}

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null })

  const job = await downloadQueue.add('download', {
    magnetLink: magnet,
    name,
  })

  const addedAt = Date.now()

  await redis.hset(`torrent:info:${job.id}`, {
    name,
    size: '0',
    status: 'queued',
    progress: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    numPeers: '0',
    eta: '-1',
    addedAt: addedAt.toString(),
    files: '[]',
  })

  await redis.zadd('torrent:jobs', addedAt, job.id!)

  console.log(`Queued: ${name}`)
  console.log(`ID:     ${job.id}`)

  await downloadQueue.disconnect()
  await redis.disconnect()
  process.exit(0)
}
