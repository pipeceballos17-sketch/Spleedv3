import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  costEvents,
  icps as icpsTable,
  leads as leadsTable,
  scoutRuns as scoutRunsTable,
} from '@spleed/db'
import { ApolloClient, type ApolloPerson } from '@spleed/integrations/apollo'
import {
  calculateSQLFitScore,
  parseICPToApolloFilters,
  type IcpRow,
} from '../agents/scout'
import type { WorkerContext } from './context'
import { defineWorker } from './define'

/**
 * Sprint 5a Scout worker. Pipeline: load ICP → Apollo search (mock by default) →
 * SQL fit-score → top-N → insert leads.
 *
 * Sprint 5b layers in LLM re-ranking (ADR 0002 Phase 3), cron triggers,
 * Slack notification, and granular error categorization. Sprint 5a does
 * basic try/catch: any failure → status='failed' + errorSummary populated.
 *
 * Idempotency: scout job IDs are scoped by runId so re-enqueues of the same
 * run are a BullMQ no-op (prevents duplicate Apollo calls on retry/restart).
 */
const ScoutJobSchema = z.object({
  runId: z.string().uuid(),
  orgId: z.string().uuid(),
  icpId: z.string().uuid(),
  requestedVolume: z.number().int().positive().max(500),
  triggerType: z.enum(['on_demand', 'manual_test']),
})

export type ScoutJob = z.infer<typeof ScoutJobSchema>

export interface ScoutResult {
  ok: true
  apolloCandidatesFound: number
  sqlFilteredCount: number
  leadsInsertedCount: number
  status: 'completed' | 'partial' | 'failed'
}

/**
 * Apollo per-credit price assumption for cost_events. Apollo's Pro tier bills
 * ~$0.05 / credit-equivalent (~$0.05 per matched person or per email reveal).
 * Free tier is effectively $0 but we record the would-be Pro cost so dashboard
 * projections survive a tier upgrade without backfill.
 */
const APOLLO_USD_PER_CREDIT = 0.05

/**
 * Optional injection point for tests: lets the test substitute a custom
 * ApolloClient instance (e.g. one that throws to exercise the error path)
 * without touching the worker's job payload schema. Production callers
 * always omit this — the worker constructs its own mock-default client.
 */
export interface ProcessScoutJobOverrides {
  apollo?: ApolloClient
}

/**
 * Core Scout job processor. Extracted from the BullMQ wrapper so tests can
 * exercise the full DB pipeline without spinning up Redis. Production path
 * routes through `scoutWorker` (defineWorker), which adds audit logging,
 * retry classification, and structured failure handling.
 */
export async function processScoutJob(
  job: { data: ScoutJob },
  ctx: WorkerContext,
  overrides: ProcessScoutJobOverrides = {},
): Promise<ScoutResult> {
  const { runId, orgId, icpId, requestedVolume } = job.data
  const raw = ctx.db.raw

  // ─── Mark run as running ───────────────────────────────────────────
  await raw
    .update(scoutRunsTable)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(scoutRunsTable.id, runId), eq(scoutRunsTable.orgId, orgId)))

  try {
    // ─── Load ICP ──────────────────────────────────────────────────────
    const icpRows = await raw
      .select()
      .from(icpsTable)
      .where(and(eq(icpsTable.id, icpId), eq(icpsTable.orgId, orgId)))
    const icp: IcpRow | undefined = icpRows[0]
    if (!icp) {
      throw new Error(`ICP_NOT_FOUND: icp=${icpId} org=${orgId}`)
    }

    // ─── Apollo search ────────────────────────────────────────────────
    const filters = parseICPToApolloFilters(icp)
    // Oversample 2x so SQL filter has headroom to discard low-fit candidates.
    // requestedVolume=50 → ask Apollo for 100, then top-50 after scoring.
    const apolloLimit = Math.min(500, requestedVolume * 2)
    // Sprint 5a uses literal 'mock' key — mock client ignores it. Sprint 6+
    // will resolve per-tenant key from Vault. Tests can inject a custom client.
    const apollo = overrides.apollo ?? new ApolloClient({ apiKey: 'mock' })

    let apolloCandidates: ApolloPerson[]
    let totalFound: number
    let creditsConsumed: number
    const apolloStart = Date.now()
    try {
      const result = await apollo.searchPeople({ ...filters, limit: apolloLimit })
      apolloCandidates = result.candidates
      totalFound = result.totalFound
      creditsConsumed = result.creditsConsumed

      // Cost event — success path.
      await raw.insert(costEvents).values({
        orgId,
        runId,
        agentType: 'scout',
        provider: 'apollo',
        operationType: 'search',
        costUsd: (creditsConsumed * APOLLO_USD_PER_CREDIT).toFixed(6),
        latencyMs: Date.now() - apolloStart,
        success: true,
        metadata: { filters, totalFound, returned: apolloCandidates.length },
      })
    } catch (apolloErr) {
      // Cost event — failure path (no credits charged, but track latency).
      await raw.insert(costEvents).values({
        orgId,
        runId,
        agentType: 'scout',
        provider: 'apollo',
        operationType: 'search',
        costUsd: '0.000000',
        latencyMs: Date.now() - apolloStart,
        success: false,
        errorCode: apolloErr instanceof Error ? apolloErr.message.slice(0, 200) : 'UNKNOWN',
        metadata: { filters },
      })
      throw apolloErr
    }

    ctx.logger.info(
      { runId, apolloFound: totalFound, returned: apolloCandidates.length },
      'scout: apollo search complete',
    )

    // ─── SQL fit_score + top-N selection ──────────────────────────────
    const scored = apolloCandidates
      .map((c) => ({ candidate: c, score: calculateSQLFitScore(c, icp) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, requestedVolume)

    const sqlFilteredCount = scored.length

    // ─── Insert leads with ON CONFLICT DO NOTHING ─────────────────────
    let leadsInsertedCount = 0
    if (scored.length > 0) {
      const rowsToInsert = scored.map(({ candidate, score }) => ({
        orgId,
        icpId,
        runId,
        status: 'discovered' as const,
        fullName: candidate.full_name,
        firstName: candidate.first_name,
        lastName: candidate.last_name,
        company: candidate.company,
        role: candidate.title,
        companyDomain: candidate.company_domain ?? null,
        email: candidate.email ?? null,
        linkedinUrl: candidate.linkedin_url ?? null,
        xHandle: candidate.x_handle ?? null,
        githubHandle: candidate.github_handle ?? null,
        foundVia: 'apollo_scout_v1',
        fitScore: score,
        fitScoreComputedAt: new Date(),
        rawSignals: {
          apollo_person: candidate as unknown as Record<string, unknown>,
          scout_run_id: runId,
          score_phase: 'sql_v1',
        },
      }))

      // onConflictDoNothing catches BOTH unique constraints
      // (leads_org_email_active_unique, leads_org_linkedin_active_unique)
      // because no target is specified. Returning gives us the actually-
      // inserted rows so we can detect dedup as a count gap.
      const inserted = await raw
        .insert(leadsTable)
        .values(rowsToInsert)
        .onConflictDoNothing()
        .returning({ id: leadsTable.id })

      leadsInsertedCount = inserted.length
    }

    // ─── Mark run as completed or partial ─────────────────────────────
    const dedupCount = sqlFilteredCount - leadsInsertedCount
    const finalStatus: 'completed' | 'partial' =
      dedupCount > 0 ? 'partial' : 'completed'

    await raw
      .update(scoutRunsTable)
      .set({
        status: finalStatus,
        finishedAt: new Date(),
        apolloCandidatesFound: totalFound,
        sqlFilteredCount,
        leadsInsertedCount,
      })
      .where(and(eq(scoutRunsTable.id, runId), eq(scoutRunsTable.orgId, orgId)))

    return {
      ok: true as const,
      apolloCandidatesFound: totalFound,
      sqlFilteredCount,
      leadsInsertedCount,
      status: finalStatus,
    }
  } catch (err) {
    // Baseline error handler — Sprint 5b will classify into transient /
    // permanent / rate-limit / config buckets so retries are surgical.
    const message = err instanceof Error ? err.message : String(err)
    const code = message.includes(':') ? message.split(':')[0]!.trim() : 'UNKNOWN'
    await raw
      .update(scoutRunsTable)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorSummary: { code, message: message.slice(0, 500) },
      })
      .where(and(eq(scoutRunsTable.id, runId), eq(scoutRunsTable.orgId, orgId)))

    ctx.logger.error({ runId, code, error: message }, 'scout: run failed')
    throw err
  }
}

export const scoutWorker = defineWorker<ScoutJob, ScoutResult>({
  queueName: 'scout',
  jobSchema: ScoutJobSchema,
  concurrency: 2,
  // BullMQ rule: custom jobIds may contain 0 colons OR exactly 2. Hyphen
  // delimiter keeps the prefix visible in BullMQ dashboards without tripping
  // that validation. runId is a UUID so global uniqueness is preserved.
  idempotencyKey: (job) => `scout-${job.runId}`,
  process: (job, ctx) => processScoutJob(job, ctx),
})
