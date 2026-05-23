/**
 * Sprint 7a — BullMQ job polling helper for synchronous-mode API
 * handlers (POST /api/leads/ingest?wait=true).
 *
 * Polls a job by id until it reaches a terminal state ('completed' or
 * 'failed') or the timeout elapses. Default poll interval is 500ms;
 * Bun's setTimeout is fine here — these calls run on the API process,
 * not inside a worker.
 *
 * The 90-second hard cap on timeoutMs protects against Bun.serve socket
 * timeouts and load-balancer ceilings. Mock-mode Profiler completes
 * within seconds; real-mode Sprint 7+ Apify/Anthropic calls may take
 * 60-90s during heavy load — caller chooses lower timeouts for tighter
 * UX (mobile network) and higher for desktop founder workflows.
 */

import { Queue, type JobType } from 'bullmq'
import { getRedisConnection } from '@spleed/agents/workers'

export type WaitForJobResult =
  | { status: 'completed'; jobId: string }
  | { status: 'failed'; jobId: string; error?: string }
  | { status: 'timeout'; jobId: string }

export interface WaitForJobInput {
  queueName: string
  jobId: string
  timeoutMs: number
  /** Default 500ms. Lower for fast mocks in tests, higher to reduce Redis pressure. */
  pollIntervalMs?: number
}

/**
 * Terminal states — Bun's setTimeout poll exits as soon as one is hit.
 * Other states ('waiting', 'active', 'delayed', etc.) loop until terminal
 * or timeout.
 */
const TERMINAL_STATES = new Set<JobType | string>(['completed', 'failed'])

export async function waitForJob(input: WaitForJobInput): Promise<WaitForJobResult> {
  const pollIntervalMs = input.pollIntervalMs ?? 500
  const startMs = Date.now()
  const queue = new Queue(input.queueName, { connection: getRedisConnection() })

  try {
    while (Date.now() - startMs < input.timeoutMs) {
      const job = await queue.getJob(input.jobId)
      if (!job) {
        // Race: enqueue → getJob within ms. Wait a tick and retry.
        await new Promise((r) => setTimeout(r, pollIntervalMs))
        continue
      }
      const state = await job.getState()
      if (TERMINAL_STATES.has(state)) {
        if (state === 'completed') {
          return { status: 'completed', jobId: input.jobId }
        }
        return {
          status: 'failed',
          jobId: input.jobId,
          error: job.failedReason ?? 'unknown',
        }
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }
    return { status: 'timeout', jobId: input.jobId }
  } finally {
    // Close opens-per-handler. Sprint 12+ may pool if request volume warrants.
    await queue.close()
  }
}
