import { Queue, type QueueOptions } from 'bullmq'
import IORedis from 'ioredis'
import { TaggedAgentError } from '../runtime/errors'

let _connection: IORedis | null = null

/**
 * Singleton Redis connection. BullMQ requires `maxRetriesPerRequest: null` and
 * `enableReadyCheck: false` for worker connections; we apply both globally so
 * both Queue (producer) and Worker (consumer) share the same connection.
 */
export function getRedisConnection(): IORedis {
  if (_connection) return _connection
  const url = process.env.REDIS_URL
  if (!url) {
    throw new TaggedAgentError(
      'REDIS_NOT_CONFIGURED',
      'REDIS_URL missing from process.env. Workers cannot start without it. Add it to .env.local.',
    )
  }
  _connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })
  return _connection
}

export async function closeRedisConnection(): Promise<void> {
  if (_connection) {
    await _connection.quit()
    _connection = null
  }
}

/**
 * Create a BullMQ Queue bound to the shared Redis connection. Used internally
 * by defineWorker's enqueue() and from any code that needs ad-hoc enqueueing.
 */
export function createQueue<T = unknown>(name: string, options: Partial<QueueOptions> = {}): Queue<T> {
  return new Queue<T>(name, { connection: getRedisConnection(), ...options })
}
