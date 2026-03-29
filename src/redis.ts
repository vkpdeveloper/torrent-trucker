import { Redis } from 'ioredis'
import { EventEmitter } from 'events'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

function createClient(name?: string) {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  })
  client.on('error', (err) => console.error(`[Redis${name ? `:${name}` : ''}] ${err.message}`))
  return client
}

// General operations (hset, hgetall, zadd, etc.)
export const redis = createClient('main')

// Dedicated publisher — cannot use for blocking ops while publishing
export const pub = createClient('pub')

// Subscriber for update events — server uses this for SSE
const updateSub = createClient('updateSub')

// Subscriber for worker command channels
export const cmdSub = createClient('cmdSub')

export const UPDATES_CHANNEL = 'torrent:updates'
export const CMD_CHANNEL = (jobId: string) => `torrent:cmd:${jobId}`

// SSE emitter: routes Redis pub/sub messages to connected SSE clients
export const sseEmitter = new EventEmitter()
sseEmitter.setMaxListeners(200)

updateSub.subscribe(UPDATES_CHANNEL)
updateSub.on('message', (_channel, message) => {
  sseEmitter.emit('update', message)
})

// Command emitter: routes command messages to active worker handlers
export const cmdEmitter = new EventEmitter()
cmdEmitter.setMaxListeners(200)

cmdSub.on('message', (channel, message) => {
  cmdEmitter.emit(channel, message)
})
