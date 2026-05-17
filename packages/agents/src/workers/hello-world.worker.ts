import { z } from 'zod'
import { errors } from '../runtime/errors'
import { defineWorker } from './define'

/**
 * Reference worker — smoke test for the worker + scoped DB + retry stack.
 * Echoes the input and writes one audit_log via ctx.db. Sprint 5+ replaces
 * this with per-agent workers (scout, profiler, …).
 */
const HelloWorldJobSchema = z.object({
  orgId: z.string().uuid(),
  leadId: z.string().uuid().optional(),
  message: z.string().min(1).max(500),
  /** Optional toggle for testing retry vs DLQ flows. */
  simulateError: z.enum(['transient', 'permanent']).optional(),
})

export type HelloWorldJob = z.infer<typeof HelloWorldJobSchema>

export interface HelloWorldResult {
  ok: true
  echo: string
  processedAt: string
}

export const helloWorldWorker = defineWorker<HelloWorldJob, HelloWorldResult>({
  queueName: 'hello-world',
  jobSchema: HelloWorldJobSchema,
  concurrency: 4,
  idempotencyKey: (job) =>
    `${job.orgId}:${job.leadId ?? 'noLead'}:${job.message.slice(0, 60)}`,
  async process(job, ctx) {
    ctx.logger.info({ message: job.data.message }, 'hello-world processing')

    if (job.data.simulateError === 'transient') {
      throw errors.rateLimit('test', 1)
    }
    if (job.data.simulateError === 'permanent') {
      throw errors.authFailed('test')
    }

    // Prove the scoped DB works: insert an audit_log via the worker context.
    // entityId: null because BullMQ jobIds are composite strings (from
    // idempotencyKey) and audit_logs.entity_id is a uuid column.
    // Track the jobId in payload instead — see defineWorker for the same fix.
    await ctx.db.auditLogs.insert({
      action: 'hello_world.processed',
      entityType: 'job',
      entityId: null,
      payload: {
        message: job.data.message,
        leadId: job.data.leadId ?? null,
        jobId: ctx.jobId,
      },
    })

    return {
      ok: true as const,
      echo: `${job.data.message} processed`,
      processedAt: new Date().toISOString(),
    }
  },
})
