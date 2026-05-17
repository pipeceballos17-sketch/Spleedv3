import {
  UnrecoverableError,
  Worker as BullWorker,
  type Job,
  type JobsOptions,
  type WorkerOptions,
} from 'bullmq'
import pino, { type Logger } from 'pino'
import type { z } from 'zod'
import { TaggedAgentError } from '../runtime/errors'
import { persistAuditLog } from '../runtime/trace'
import { createScopedDb, type WorkerContext } from './context'
import { createQueue, getRedisConnection } from './queue'

export interface WorkerRetryConfig {
  attempts: number
  backoff?: { type: 'exponential' | 'fixed'; delay: number }
  /** 0-1, multiplier applied to backoff delay as ± jitter. Default 0.3 (30%). */
  jitter?: number
}

const DEFAULT_RETRY: WorkerRetryConfig = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  jitter: 0.3,
}

export interface DefineWorkerInput<TJob extends { orgId: string }, TResult> {
  /** BullMQ queue name. Must be unique across the codebase. */
  queueName: string
  /** Zod schema for the job payload. Validated on both enqueue and process. */
  jobSchema: z.ZodType<TJob>
  /** Concurrent jobs this worker processes. Defaults to WORKER_CONCURRENCY env var or 4. */
  concurrency?: number
  /** Per-worker retry policy. Defaults to 5 attempts, exponential 5/10/20/40/80s, 30% jitter. */
  retry?: WorkerRetryConfig
  /**
   * Compute a deterministic jobId from the validated payload. BullMQ uses this
   * to deduplicate enqueues (idempotency). Optional but strongly recommended
   * for agent workers (e.g., `${orgId}:${leadId}:enrich` so re-running
   * enrichment for the same lead is a no-op).
   */
  idempotencyKey?: (job: TJob) => string
  /** The actual job logic. Receives BullMQ Job + a fully-formed WorkerContext. */
  process: (job: Job<TJob, TResult>, ctx: WorkerContext) => Promise<TResult>
}

export interface DefinedWorker<TJob extends { orgId: string }, TResult> {
  readonly queueName: string
  readonly retry: WorkerRetryConfig
  /** Enqueue a job onto this worker's queue. Validates payload before enqueueing. */
  enqueue: (
    data: TJob,
    options?: { jobId?: string; delay?: number; priority?: number },
  ) => Promise<void>
  /** Start the BullMQ worker. Returns the underlying Worker for shutdown handling. */
  start: () => BullWorker<TJob, TResult>
}

/**
 * Define a queue + worker pair with shared name, schema, and retry policy.
 * Wraps the user-supplied process() with:
 *   1. Zod validation of the job payload (throws TOOL_INPUT_INVALID-style on bad input).
 *   2. Entry/exit/failure audit_logs (action='worker.{queueName}.start|complete|failed').
 *   3. Error classification: TaggedAgentError with transient:true → BullMQ retries;
 *      anything else → UnrecoverableError → skip remaining attempts → BullMQ failed queue.
 *   4. Per-worker Pino logger pre-bound with orgId + jobId + traceId.
 *   5. Scoped DB client (createScopedDb) so process() cannot accidentally cross orgs.
 */
export function defineWorker<TJob extends { orgId: string }, TResult>(
  config: DefineWorkerInput<TJob, TResult>,
): DefinedWorker<TJob, TResult> {
  const retry = config.retry ?? DEFAULT_RETRY

  const enqueue: DefinedWorker<TJob, TResult>['enqueue'] = async (data, options = {}) => {
    const validated = config.jobSchema.parse(data)
    const jobId = options.jobId ?? config.idempotencyKey?.(validated)
    const jobOpts: JobsOptions = {
      jobId,
      delay: options.delay,
      priority: options.priority,
      attempts: retry.attempts,
      backoff: retry.backoff,
    }
    const queue = createQueue<TJob>(config.queueName)
    // BullMQ 5.76+ uses ExtractNameType + ExtractDataType utility types on
    // add(), which TS can't infer correctly through our generic createQueue
    // helper. Cast both args — runtime types are guaranteed by zod validation
    // above (`config.jobSchema.parse(data)`).
    await queue.add(config.queueName as never, validated as never, jobOpts)
    await queue.close()
  }

  const start = (): BullWorker<TJob, TResult> => {
    const opts: WorkerOptions = {
      connection: getRedisConnection(),
      concurrency: config.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 4),
    }

    // Worker-scoped logger. `base.queue` auto-attaches to every log line, so
    // listeners below don't need to repeat the queue name in each payload.
    const workerLogger: Logger = pino({
      name: `worker:${config.queueName}`,
      base: { queue: config.queueName },
    })

    const worker = new BullWorker<TJob, TResult>(
      config.queueName,
      async (job) => {
        const validated = config.jobSchema.parse(job.data)
        const orgId = validated.orgId
        const traceId = job.opts.jobId ?? `${config.queueName}:${job.id}`
        const logger: Logger = pino({
          name: `worker:${config.queueName}`,
          base: { orgId, jobId: job.id, traceId, attempt: job.attemptsMade + 1 },
        })
        const ctx: WorkerContext = {
          orgId,
          jobId: job.id ?? `unknown-${Date.now()}`,
          traceId,
          attemptsMade: job.attemptsMade,
          logger,
          db: createScopedDb(orgId),
        }

        await persistAuditLog({
          orgId,
          action: `worker.${config.queueName}.start`,
          entityType: 'worker',
          // entity_id is uuid in audit_logs; BullMQ jobIds are composite strings
          // (from idempotencyKey). The jobId lives in `traceId` inside payload.
          entityId: null,
          payload: { traceId, attempt: ctx.attemptsMade + 1 },
        })

        const startTs = Date.now()
        try {
          const result = await config.process(job, ctx)
          await persistAuditLog({
            orgId,
            action: `worker.${config.queueName}.complete`,
            entityType: 'worker',
            // entity_id is uuid in audit_logs; BullMQ jobIds are composite strings
          // (from idempotencyKey). The jobId lives in `traceId` inside payload.
          entityId: null,
            payload: { traceId, durationMs: Date.now() - startTs },
          })
          return result
        } catch (err) {
          const isTransient = err instanceof TaggedAgentError && err.transient
          const classification: 'retry' | 'dlq' = isTransient ? 'retry' : 'dlq'

          await persistAuditLog({
            orgId,
            action: `worker.${config.queueName}.failed`,
            entityType: 'worker',
            // entity_id is uuid in audit_logs; BullMQ jobIds are composite strings
          // (from idempotencyKey). The jobId lives in `traceId` inside payload.
          entityId: null,
            payload: {
              traceId,
              durationMs: Date.now() - startTs,
              error: err instanceof Error ? err.message : String(err),
              errorTag: err instanceof TaggedAgentError ? err.tag : null,
              classification,
              attempt: ctx.attemptsMade + 1,
              maxAttempts: retry.attempts,
            },
          })

          if (classification === 'dlq') {
            throw new UnrecoverableError(
              err instanceof Error ? err.message : String(err),
            )
          }
          throw err
        }
      },
      opts,
    )

    // ─── BullMQ observability listeners (production-grade) ─────────────
    // Gated by pino log level. info+/warn/error always emit; debug events
    // (active/completed) require LOG_LEVEL=debug. Sprint 3 keeps these in
    // place permanently — they were diagnostic during Sprint 3 worker debug
    // but are valuable for production triage. Move pino transport (console
    // → file or external aggregator) in Sprint 12 hardening if needed.
    worker.on('error', (err) => {
      workerLogger.error(
        { error: err.message, stack: err.stack },
        '[WORKER ERROR]',
      )
    })
    worker.on('failed', (job, err) => {
      workerLogger.warn(
        { jobId: job?.id, attempt: job?.attemptsMade, error: err.message },
        '[JOB FAILED]',
      )
    })
    worker.on('active', (job) => {
      workerLogger.debug({ jobId: job.id, data: job.data }, '[JOB ACTIVE]')
    })
    worker.on('completed', (job) => {
      workerLogger.debug({ jobId: job.id }, '[JOB COMPLETED]')
    })
    worker.on('stalled', (jobId) => {
      workerLogger.warn({ jobId }, '[JOB STALLED]')
    })
    worker.on('ready', () => {
      workerLogger.info({ concurrency: opts.concurrency }, '[WORKER READY]')
    })
    // ──────────────────────────────────────────────────────────────────

    return worker
  }

  return { queueName: config.queueName, retry, enqueue, start }
}
