import { Redis } from 'ioredis'
import { pub, CMD_CHANNEL } from '../redis.ts'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

export async function commandRm(args: string[]) {
  const id = args[0]

  if (!id) {
    process.stderr.write('Usage: tt rm <id>\n')
    process.exit(1)
  }

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null })

  const raw = await redis.hgetall(`torrent:info:${id}`)
  if (!raw || !raw.name) {
    process.stderr.write(`Error: no download found with id "${id}"\n`)
    await redis.disconnect()
    await pub.disconnect()
    process.exit(1)
  }

  const status = raw.status || 'queued'

  // If actively downloading or paused, send stop command first
  if (status === 'downloading' || status === 'paused') {
    await pub.publish(CMD_CHANNEL(id), JSON.stringify({ action: 'stop' }))
    // Give daemon a moment to process it
    await new Promise((r) => setTimeout(r, 500))
  }

  // Remove Redis keys
  await redis.del(`torrent:info:${id}`)
  await redis.zrem('torrent:jobs', id)

  console.log(`Removed: ${raw.name} (${id.slice(0, 8)})`)

  await redis.disconnect()
  await pub.disconnect()
}
