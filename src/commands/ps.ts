import { Redis } from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const POLL_INTERVAL = 5_000

interface TorrentInfo {
  id: string
  name: string
  status: string
  progress: number
  downloadSpeed: number
  numPeers: number
  eta: number
  size: number
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function formatEta(etaMs: number): string {
  if (etaMs < 0) return '--:--'
  if (etaMs === 0) return 'Done'
  const secs = Math.floor(etaMs / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

async function fetchAll(redis: Redis): Promise<TorrentInfo[]> {
  const ids = await redis.zrange('torrent:jobs', 0, -1)
  if (!ids.length) return []

  const results: TorrentInfo[] = []
  for (const id of ids) {
    const raw = await redis.hgetall(`torrent:info:${id}`)
    if (!raw || !raw.name) continue
    results.push({
      id,
      name: raw.name || 'Unknown',
      status: raw.status || 'queued',
      progress: parseFloat(raw.progress || '0'),
      downloadSpeed: parseInt(raw.downloadSpeed || '0'),
      numPeers: parseInt(raw.numPeers || '0'),
      eta: parseInt(raw.eta || '-1'),
      size: parseInt(raw.size || '0'),
    })
  }
  return results.reverse()
}

function render(torrents: TorrentInfo[]) {
  const cols = process.stdout.columns || 80
  const barWidth = Math.max(10, Math.min(30, cols - 52))

  const lines: string[] = []

  lines.push(`TT — torrent trucker   ${new Date().toLocaleTimeString()}   press Ctrl+C to quit`)
  lines.push('─'.repeat(cols))

  if (torrents.length === 0) {
    lines.push('  No downloads. Run: tt add <magnet>')
  } else {
    for (const tor of torrents) {
      const pct = Math.min(100, Math.max(0, tor.progress))
      const bar = progressBar(pct, barWidth)
      const maxName = Math.max(10, cols - barWidth - 32)
      const name = tor.name.length > maxName
        ? tor.name.slice(0, maxName - 1) + '…'
        : tor.name

      const speed = tor.status === 'downloading' ? `  ${formatBytes(tor.downloadSpeed)}/s` : ''
      const eta   = tor.status === 'downloading' ? `  ETA ${formatEta(tor.eta)}` : ''
      const peers = tor.status === 'downloading' ? `  ${tor.numPeers} peers` : ''

      lines.push(`  ${name}  [${tor.status}]${speed}${eta}${peers}`)
      lines.push(`  ${bar} ${pct.toFixed(1)}%  ${formatBytes(tor.size)}  id:${tor.id.slice(0, 8)}`)
      lines.push('')
    }
  }

  // Move cursor to top-left, clear screen, print
  process.stdout.write('\x1b[H\x1b[J' + lines.join('\n') + '\n')
}

export async function commandPs() {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null })

  // Initial render immediately
  let torrents = await fetchAll(redis)
  render(torrents)

  // Poll every 5s
  const pollTimer = setInterval(async () => {
    torrents = await fetchAll(redis)
    render(torrents)
  }, POLL_INTERVAL)

  // Cleanup on Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(pollTimer)
    redis.disconnect()
    process.stdout.write('\x1b[?25h') // restore cursor
    process.exit(0)
  })
}
