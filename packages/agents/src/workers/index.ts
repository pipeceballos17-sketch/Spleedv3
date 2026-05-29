import type { Worker } from 'bullmq'
import { closeRedisConnection } from './queue'
import { helloWorldWorker } from './hello-world.worker'
import { scoutWorker } from './scout.worker'
import { profilerWorker } from './profiler.worker'
import { conciergeWorker } from './concierge.worker'

/**
 * Registry of all workers started by `startAllWorkers()`. Sprint 5+ appends
 * scout/profiler/composer/outreach/gifter/concierge workers here.
 */
export const ALL_WORKERS = [
  helloWorldWorker,
  scoutWorker,
  profilerWorker,
  conciergeWorker,
] as const

export interface RunningWorkers {
  readonly count: number
  readonly workers: ReadonlyArray<Worker>
  readonly stop: () => Promise<void>
}

/**
 * Start every registered worker and return a handle for clean shutdown.
 * Called from `apps/api/src/workers/start.ts` on API boot.
 */
export function startAllWorkers(): RunningWorkers {
  const workers = ALL_WORKERS.map((w) => w.start())
  return {
    count: workers.length,
    workers,
    stop: async () => {
      await Promise.all(workers.map((w) => w.close()))
      await closeRedisConnection()
    },
  }
}

export { defineWorker, type DefineWorkerInput, type DefinedWorker, type WorkerRetryConfig } from './define'
export { createScopedDb, type ScopedDb, type WorkerContext } from './context'
export { getRedisConnection, closeRedisConnection, createQueue } from './queue'
export { helloWorldWorker, type HelloWorldJob, type HelloWorldResult } from './hello-world.worker'
export { scoutWorker, processScoutJob, type ScoutJob, type ScoutResult } from './scout.worker'
export {
  registerScoutCronForOrg,
  unregisterScoutCronForOrg,
  pauseScoutCron,
  resumeScoutCron,
  getScoutCron,
  scoutCronSchedulerId,
} from './scout-cron'
export {
  profilerWorker,
  processProfilerJob,
  type ProfilerJob,
  type ProfilerResult,
  type ProcessProfilerJobOverrides,
} from './profiler.worker'
export {
  conciergeWorker,
  processConciergeJob,
  ConciergeJobSchema,
  type ConciergeJob,
  type ConciergeResult,
  type ProcessConciergeJobOverrides,
} from './concierge.worker'
export { enqueueConciergeJob } from '../queues/concierge.queue'
export { waitForJob, type WaitForJobInput, type WaitForJobResult } from './wait-for-job'
