import { Redis } from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function pad(str: string, len: number): string {
  return str.length > len ? str.slice(0, len - 1) + '…' : str.padEnd(len)
}

const STATUS_ICON: Record<string, string> = {
  downloading: '↓',
  completed:   '✓',
  paused:      '⏸',
  error:       '✗',
  stopped:     '■',
  queued:      '○',
}

export async function commandLs() {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null })

  const ids = await redis.zrange('torrent:jobs', 0, -1, 'REV')

  if (!ids.length) {
    console.log('No downloads.')
    await redis.disconnect()
    process.exit(0)
  }

  const COL_ID    = 8
  const COL_ST    = 2
  const COL_PROG  = 7
  const COL_SIZE  = 9
  const termW     = process.stdout.columns || 80
  const COL_NAME  = Math.max(20, termW - COL_ID - COL_ST - COL_PROG - COL_SIZE - 7)

  const header = [
    pad('ID',       COL_ID),
    pad('S',        COL_ST),
    pad('NAME',     COL_NAME),
    pad('PROGRESS', COL_PROG),
    pad('SIZE',     COL_SIZE),
  ].join('  ')

  console.log(header)
  console.log('─'.repeat(header.length))

  for (const id of ids) {
    const raw = await redis.hgetall(`torrent:info:${id}`)
    if (!raw || !raw.name) continue

    const status   = raw.status || 'queued'
    const icon     = STATUS_ICON[status] ?? '?'
    const progress = parseFloat(raw.progress || '0')
    const size     = parseInt(raw.size || '0')

    const row = [
      pad(id.slice(0, COL_ID), COL_ID),
      pad(icon, COL_ST),
      pad(raw.name, COL_NAME),
      pad(`${progress.toFixed(1)}%`, COL_PROG),
      pad(formatBytes(size), COL_SIZE),
    ].join('  ')

    console.log(row)
  }

  await redis.disconnect()
  process.exit(0)
}
