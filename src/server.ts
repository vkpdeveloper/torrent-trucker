import { downloadQueue } from './queue.ts'
import { redis, pub, sseEmitter, CMD_CHANNEL } from './redis.ts'
import parseTorrent from 'parse-torrent'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

const VIEWS_DIR = join(import.meta.dir, '../views')

function view(name: string) {
  return readFileSync(join(VIEWS_DIR, name), 'utf-8')
}

function html(name: string) {
  return new Response(view(name), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

export function startServer(port: number) {
  Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const { method, pathname } = { method: req.method, pathname: url.pathname }

      // ── Pages ──────────────────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/') return html('index.html')
      if (method === 'GET' && pathname === '/downloads') return html('downloads.html')

      // ── Upload torrent ─────────────────────────────────────────────────────
      if (method === 'POST' && pathname === '/api/upload') {
        try {
          const form = await req.formData()
          const file = form.get('torrent') as File | null
          if (!file) return Response.json({ error: 'No torrent file provided' }, { status: 400 })
          if (!file.name.endsWith('.torrent')) {
            return Response.json({ error: 'File must be a .torrent file' }, { status: 400 })
          }

          const buffer = Buffer.from(await file.arrayBuffer())

          // Parse metadata before queuing
          let name = file.name.replace(/\.torrent$/i, '')
          let size = 0
          try {
            const parsed = await (parseTorrent as any)(buffer)
            if (parsed?.name) name = String(parsed.name)
            if (typeof parsed?.length === 'number') size = parsed.length
          } catch {
            // Best-effort: fall back to filename
          }

          // Store raw torrent bytes in Redis (auto-expire in 24h; worker deletes on completion)
          const torrentKey = `torrent:file:${randomUUID()}`
          await redis.set(torrentKey, buffer, 'EX', 86400)

          // Enqueue download job
          const job = await downloadQueue.add('download', {
            torrentKey,
            name,
            size,
            addedAt: Date.now(),
          })

          // Initialise info hash
          await redis.hset(`torrent:info:${job.id}`, {
            name,
            size: size.toString(),
            status: 'queued',
            progress: '0',
            downloadSpeed: '0',
            uploadSpeed: '0',
            numPeers: '0',
            eta: '-1',
            addedAt: Date.now().toString(),
            files: '[]',
          })

          // Add to ordered job index (newest first)
          await redis.zadd('torrent:jobs', Date.now(), job.id!)

          // Notify SSE clients about the new queued item
          await pub.publish(
            'torrent:updates',
            JSON.stringify({
              jobId: job.id,
              type: 'queued',
              data: { name, size, status: 'queued', progress: 0, addedAt: Date.now() },
            }),
          )

          return Response.json({ jobId: job.id, name, size })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Upload failed'
          console.error('[Server] Upload error:', msg)
          return Response.json({ error: msg }, { status: 500 })
        }
      }

      // ── List all downloads ─────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/downloads') {
        const ids = await redis.zrevrange('torrent:jobs', 0, -1)
        const downloads = await Promise.all(
          ids.map(async (id) => {
            const info = await redis.hgetall(`torrent:info:${id}`)
            return { id, ...info }
          }),
        )
        return Response.json(downloads)
      }

      // ── SSE stream ─────────────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/events') {
        const encoder = new TextEncoder()
        let closed = false

        const stream = new ReadableStream({
          async start(controller) {
            const enqueue = (data: string) => {
              if (!closed) {
                try {
                  controller.enqueue(encoder.encode(`data: ${data}\n\n`))
                } catch {
                  closed = true
                }
              }
            }

            // Send full current state on connect
            const ids = await redis.zrevrange('torrent:jobs', 0, -1)
            const downloads = await Promise.all(
              ids.map(async (id) => {
                const info = await redis.hgetall(`torrent:info:${id}`)
                return { id, ...info }
              }),
            )
            enqueue(JSON.stringify({ type: 'init', downloads }))

            const handler = (message: string) => enqueue(message)
            sseEmitter.on('update', handler)

            req.signal.addEventListener('abort', () => {
              closed = true
              sseEmitter.off('update', handler)
              try { controller.close() } catch { /* already closed */ }
            })
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        })
      }

      // ── Download controls (pause / resume / stop) ──────────────────────────
      const ctrlMatch = pathname.match(/^\/api\/downloads\/([^/]+)\/(pause|resume|stop)$/)
      if (method === 'POST' && ctrlMatch) {
        const [, jobId, action] = ctrlMatch
        await pub.publish(CMD_CHANNEL(jobId), JSON.stringify({ action }))

        // Update Redis status optimistically for queued jobs (not yet active in worker)
        if (action === 'stop') {
          const info = await redis.hgetall(`torrent:info:${jobId}`)
          if (info.status === 'queued') {
            await redis.hset(`torrent:info:${jobId}`, { status: 'stopped' })
            await pub.publish(
              'torrent:updates',
              JSON.stringify({ jobId, type: 'status', data: { status: 'stopped' } }),
            )
          }
        }

        return Response.json({ success: true })
      }

      // ── Delete a download ─────────────────────────────────────────────────
      const delMatch = pathname.match(/^\/api\/downloads\/([^/]+)$/)
      if (method === 'DELETE' && delMatch) {
        const [, jobId] = delMatch
        // Stop active download if running
        await pub.publish(CMD_CHANNEL(jobId), JSON.stringify({ action: 'stop' }))
        // Clean up all Redis keys
        await redis.del(`torrent:info:${jobId}`)
        await redis.zrem('torrent:jobs', jobId)
        await pub.publish(
          'torrent:updates',
          JSON.stringify({ jobId, type: 'deleted', data: {} }),
        )
        return Response.json({ success: true })
      }

      return new Response('Not Found', { status: 404 })
    },
  })

  console.log(`[Server] Listening on http://localhost:${port}`)
}
