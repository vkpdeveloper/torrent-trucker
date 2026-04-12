import { createCliRenderer, Box, Text, t, bold, fg, TextAttributes } from '@opentui/core'
import { Redis } from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

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

function statusColor(status: string): string {
  switch (status) {
    case 'downloading': return '#22c55e'
    case 'paused':      return '#f59e0b'
    case 'completed':   return '#3b82f6'
    case 'error':       return '#ef4444'
    case 'stopped':     return '#6b7280'
    default:            return '#9ca3af'
  }
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width)
  const empty = width - filled
  return '█'.repeat(filled) + '░'.repeat(empty)
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

export async function commandPs() {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null })
  const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: null })

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: 'alternate-screen',
    consoleMode: 'disabled',
  })

  // State
  let torrents: TorrentInfo[] = await fetchAll(redis)

  function buildUI() {
    const termW = renderer.width
    const barWidth = Math.max(10, Math.min(40, termW - 50))

    // Header
    const header = Box(
      {
        width: '100%',
        height: 3,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 2,
        paddingRight: 2,
        backgroundColor: '#111827',
        borderStyle: 'single',
      },
      Text({
        content: t`${bold(fg('#22c55e')('TT'))} ${fg('#9ca3af')('torrent trucker')}`,
      }),
      Box({ flexGrow: 1 }),
      Text({
        content: t`${fg('#9ca3af')(new Date().toLocaleTimeString())}  ${fg('#6b7280')('q to quit')}`,
      }),
    )

    if (torrents.length === 0) {
      return Box(
        { width: '100%', height: '100%', flexDirection: 'column' },
        header,
        Box(
          {
            flexGrow: 1,
            justifyContent: 'center',
            alignItems: 'center',
          },
          Text({
            content: t`${fg('#6b7280')('No downloads. Run ')}${fg('#22c55e')('tt add <magnet>')}${fg('#6b7280')(' to start.')}`,
          }),
        ),
        Text({
          content: ' '.repeat(termW),
          position: 'absolute',
          bottom: 0,
        }),
      )
    }

    const rows = torrents.map((t_) => {
      const pct = Math.min(100, Math.max(0, t_.progress))
      const bar = progressBar(pct, barWidth)
      const speed = t_.status === 'downloading' ? ` ${formatBytes(t_.downloadSpeed)}/s` : ''
      const eta = t_.status === 'downloading' ? ` ETA ${formatEta(t_.eta)}` : ''
      const peers = t_.status === 'downloading' ? ` ${t_.numPeers}p` : ''
      const sColor = statusColor(t_.status)
      const nameWidth = Math.max(10, termW - barWidth - 30)
      const name = t_.name.length > nameWidth ? t_.name.slice(0, nameWidth - 1) + '…' : t_.name.padEnd(nameWidth)

      return Box(
        {
          width: '100%',
          flexDirection: 'column',
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
          marginBottom: 1,
        },
        // Name + status line
        Box(
          { flexDirection: 'row', width: '100%' },
          Text({
            content: t`${fg(sColor)('●')} ${bold(name)}`,
          }),
          Box({ flexGrow: 1 }),
          Text({
            content: t`${fg(sColor)(t_.status)}${fg('#6b7280')(speed)}${fg('#6b7280')(eta)}${fg('#6b7280')(peers)}`,
          }),
        ),
        // Progress bar line
        Box(
          { flexDirection: 'row', width: '100%', marginTop: 1 },
          Text({
            content: t`  ${fg(sColor)(bar)} ${fg('#9ca3af')(`${pct.toFixed(1)}%`)} ${fg('#6b7280')(formatBytes(t_.size))}`,
          }),
          Box({ flexGrow: 1 }),
          Text({
            content: t`${fg('#6b7280')(t_.id.slice(0, 8))}`,
          }),
        ),
      )
    })

    return Box(
      { width: '100%', height: '100%', flexDirection: 'column' },
      header,
      Box(
        {
          flexGrow: 1,
          flexDirection: 'column',
          overflow: 'hidden',
          paddingTop: 1,
        },
        ...rows,
      ),
    )
  }

  function render() {
    for (const c of renderer.root.getChildren()) renderer.root.remove(c.id)
    renderer.root.add(buildUI())
  }

  render()

  // Subscribe to live updates
  await sub.subscribe('torrent:updates')
  sub.on('message', async (_ch, msg) => {
    try {
      const update = JSON.parse(msg) as { jobId: string; type: string; data: Record<string, unknown> }
      const existing = torrents.find((t_) => t_.id === update.jobId)
      if (existing) {
        if (update.data.status) existing.status = update.data.status as string
        if (update.data.progress !== undefined) existing.progress = update.data.progress as number
        if (update.data.downloadSpeed !== undefined) existing.downloadSpeed = update.data.downloadSpeed as number
        if (update.data.numPeers !== undefined) existing.numPeers = update.data.numPeers as number
        if (update.data.eta !== undefined) existing.eta = update.data.eta as number
        if (update.data.name) existing.name = update.data.name as string
        if (update.data.size) existing.size = update.data.size as number
      } else {
        // New job appeared — refetch
        torrents = await fetchAll(redis)
      }
      render()
    } catch {}
  })

  // Refresh clock + detect new jobs every 5s
  const timer = setInterval(async () => {
    torrents = await fetchAll(redis)
    render()
  }, 5000)

  // Quit on 'q'
  renderer.addInputHandler((seq) => {
    if (seq === 'q' || seq === 'Q') {
      clearInterval(timer)
      sub.disconnect()
      redis.disconnect()
      renderer.destroy()
      process.exit(0)
    }
    return false
  })

  renderer.on('destroy', () => {
    clearInterval(timer)
    sub.disconnect()
    redis.disconnect()
  })
}
