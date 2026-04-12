import { createCliRenderer, Box, Text, t, bold, fg } from '@opentui/core'
import type { ProxiedVNode } from '@opentui/core'
import type { TextRenderable } from '@opentui/core'
import type { BoxRenderable } from '@opentui/core'
import { Redis } from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

// How often to repaint the stable tree (ms)
const RENDER_INTERVAL = 250

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

type TextNode = ProxiedVNode<typeof TextRenderable>
type BoxNode  = ProxiedVNode<typeof BoxRenderable>

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

  let torrents: TorrentInfo[] = await fetchAll(redis)
  let dirty = true

  // ── Stable node references ──────────────────────────────────────────────────

  // Header clock — mutated in place each tick
  const clockText = Text({ content: '' }) as unknown as TextNode

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
    Text({ content: t`${bold(fg('#22c55e')('TT'))} ${fg('#9ca3af')('torrent trucker')}` }),
    Box({ flexGrow: 1 }),
    clockText,
  )

  // Empty-state node
  const emptyText = Text({
    content: t`${fg('#6b7280')('No downloads. Run ')}${fg('#22c55e')('tt add <magnet>')}${fg('#6b7280')(' to start.')}`,
  }) as unknown as TextNode

  const emptyBox = Box(
    { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
    emptyText,
  ) as unknown as BoxNode

  // Rows container — we add/remove row boxes here when count changes
  const rowsContainer = Box({
    flexGrow: 1,
    flexDirection: 'column',
    overflow: 'hidden',
    paddingTop: 1,
  }) as unknown as BoxNode

  const root = Box(
    { width: '100%', height: '100%', flexDirection: 'column' },
    header,
    rowsContainer,
  )

  // Per-row stable text nodes
  interface RowNodes {
    nameStatus:   TextNode
    progressLine: TextNode
    rowBox:       BoxNode
  }
  let rowNodes: RowNodes[] = []

  function ensureRows(count: number) {
    // Add missing rows
    while (rowNodes.length < count) {
      const nameStatus   = Text({ content: '' }) as unknown as TextNode
      const progressLine = Text({ content: '' }) as unknown as TextNode

      const rowBox = Box(
        {
          width: '100%',
          flexDirection: 'column',
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
          marginBottom: 1,
        },
        Box({ flexDirection: 'row', width: '100%' }, nameStatus, Box({ flexGrow: 1 })),
        Box({ flexDirection: 'row', width: '100%', marginTop: 1 }, progressLine, Box({ flexGrow: 1 })),
      ) as unknown as BoxNode

      rowsContainer.add(rowBox)
      rowNodes.push({ nameStatus, progressLine, rowBox })
    }

    // Remove excess rows
    while (rowNodes.length > count) {
      const last = rowNodes.pop()!
      rowsContainer.remove(last.rowBox.id)
      last.rowBox.destroyRecursively()
    }
  }

  let emptyBoxMounted = false

  function updateContent() {
    const termW = renderer.width
    const barWidth = Math.max(10, Math.min(40, termW - 50))

    // Update clock
    clockText.content =
      t`${fg('#9ca3af')(new Date().toLocaleTimeString())}  ${fg('#6b7280')('q to quit')}`

    if (torrents.length === 0) {
      if (!emptyBoxMounted) {
        ensureRows(0)
        rowsContainer.add(emptyBox)
        emptyBoxMounted = true
      }
      return
    }

    // Remove empty box if it was mounted
    if (emptyBoxMounted) {
      rowsContainer.remove(emptyBox.id)
      emptyBoxMounted = false
    }

    ensureRows(torrents.length)

    for (let i = 0; i < torrents.length; i++) {
      const tor   = torrents[i]!
      const nodes = rowNodes[i]!

      const pct   = Math.min(100, Math.max(0, tor.progress))
      const bar   = progressBar(pct, barWidth)
      const sColor = statusColor(tor.status)
      const nameWidth = Math.max(10, termW - barWidth - 30)
      const name  = tor.name.length > nameWidth
        ? tor.name.slice(0, nameWidth - 1) + '…'
        : tor.name.padEnd(nameWidth)

      const speed = tor.status === 'downloading' ? ` ${formatBytes(tor.downloadSpeed)}/s` : ''
      const eta   = tor.status === 'downloading' ? ` ETA ${formatEta(tor.eta)}` : ''
      const peers = tor.status === 'downloading' ? ` ${tor.numPeers}p` : ''

      nodes.nameStatus.content =
        t`${fg(sColor)('●')} ${bold(name)}  ${fg(sColor)(tor.status)}${fg('#6b7280')(speed)}${fg('#6b7280')(eta)}${fg('#6b7280')(peers)}`

      nodes.progressLine.content =
        t`  ${fg(sColor)(bar)} ${fg('#9ca3af')(`${pct.toFixed(1)}%`)} ${fg('#6b7280')(formatBytes(tor.size))}  ${fg('#6b7280')(tor.id.slice(0, 8))}`
    }
  }

  // Mount the stable root tree once
  renderer.root.add(root)
  updateContent()

  // ── Render loop: repaint at fixed interval only when dirty ──────────────────
  const renderTimer = setInterval(() => {
    if (!dirty) return
    dirty = false
    updateContent()
  }, RENDER_INTERVAL)

  // ── Data refresh: pull from Redis every 5s, then mark dirty for render ──────
  const pollTimer = setInterval(async () => {
    torrents = await fetchAll(redis)
    dirty = true
  }, 5_000)

  // Sub is kept open so we don't miss connection errors, but we ignore messages —
  // all state comes from the 5s poll above.
  await sub.subscribe('torrent:updates')

  function cleanup() {
    clearInterval(renderTimer)
    clearInterval(pollTimer)
    sub.disconnect()
    redis.disconnect()
  }

  renderer.addInputHandler((seq) => {
    if (seq === 'q' || seq === 'Q') {
      cleanup()
      renderer.destroy()
      process.exit(0)
    }
    return false
  })

  renderer.on('destroy', cleanup)
}
