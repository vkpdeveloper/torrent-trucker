import { Queue } from 'bullmq'
import { Redis } from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

export const downloadQueue = new Queue('torrent-downloads', {
  connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
    attempts: 1,
  },
})
