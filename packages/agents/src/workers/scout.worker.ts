import { and, eq, inArray, ne } from 'drizzle-orm'
import { z } from 'zod'
import {
  costEvents,
  icps as icpsTable,
  leads as leadsTable,
  orgs as orgsTable,
  scoutRuns as scoutRunsTable,
} from '@spleed/db'
import { ApolloClient, type ApolloPerson } from '@spleed/integrations/apollo'
import {
  AnthropicClient,
  type ScoreLeadResult,
} from '@spleed/integrations/anthropic'
import { SlackWebhookClient } from '@spleed/integrations/slack'
import {
  calculateSQLFitScore,
  parseICPToApolloFilters,
  type IcpRow,
} from '../agents/scout'
import { classifyError, TaggedAgentError, withTransientRetry } from '../runtime/errors'
import type { WorkerContext } from './context'
import { defineWorker } from './define'
import { profilerWorker } from './profiler.worker'

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
  // Optional in Sprint 5b — the on-demand API path enqueues with runId pre-
  // created in the DB; the cron path (BullMQ scheduler) cannot pre-generate
  // unique runIds per firing, so the worker creates the row itself when
  // runId is absent (see processScoutJob).
  runId: z.string().uuid().optional(),
  orgId: z.string().uuid(),
  icpId: z.string().uuid(),
  // Sprint 5b: matches the API max(100) — see scout.worker.ts LLM_RERANK_CAP.
  requestedVolume: z.number().int().positive().max(100),
  triggerType: z.enum(['on_demand', 'manual_test', 'cron']),
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
 * LLM cap per run. Sprint 5b hard-caps LLM scoring at 100 candidates to
 * bound cost predictability (Sonnet 4.6 input is $3/1M tokens). Founders
 * requesting volume > 100 get rejected at the API layer (zod max 100).
 * Sprint 9+ may lift the cap with smarter scoring once we have Hermes
 * feedback to justify the spend.
 */
const LLM_RERANK_CAP = 100

/**
 * Optional injection point for tests: lets tests substitute custom Apollo,
 * Anthropic, or Slack clients (e.g. a throwing apollo, a deterministic
 * anthropic) and tighten retry timing without changing the worker job
 * schema. Production callers always omit — the worker constructs its own
 * mock-default clients.
 */
export interface ProcessScoutJobOverrides {
  apollo?: ApolloClient
  anthropic?: AnthropicClient
  slack?: SlackWebhookClient
  /** Override retry pacing (used by tests to keep CI fast). */
  retryBackoffBaseMs?: number
  /** Override retry attempts. Sprint 5b spec is 3 (1s, 2s, 4s). */
  retryMaxAttempts?: number
}

/**
 * Sprint 5b CP3 — send a Slack failure or quota notice if (a) the org has a
 * webhook URL configured and (b) the error category warrants notification.
 * Per Decision E: notify on PERMANENT + QUOTA, suppress on TRANSIENT
 * (retries will recover) and PARTIAL (founder sees via API/dashboard).
 *
 * Failures of the notify itself are swallowed — Slack downtime must not
 * crash the worker (would mask the original error). Logged via ctx.logger
 * for ops visibility.
 */
async function notifySlackIfConfigured(
  ctx: WorkerContext,
  slackWebhookUrl: string | null,
  payload: {
    kind: 'failure' | 'quota'
    runId: string
    icpName: string
    error: { category: string; message: string; code?: string }
    provider?: 'apollo' | 'anthropic'
  },
  override?: SlackWebhookClient,
): Promise<void> {
  if (!slackWebhookUrl) return
  try {
    const client = override ?? new SlackWebhookClient(slackWebhookUrl)
    if (payload.kind === 'quota') {
      await client.sendQuotaExhausted({
        provider: payload.provider ?? 'apollo',
        creditsRemaining: -1,
        upgradeHint: `Upgrade your ${payload.provider ?? 'provider'} plan and re-trigger the Scout run.`,
      })
    } else {
      await client.sendScoutFailure({
        runId: payload.runId,
        icpName: payload.icpName,
        error: payload.error,
      })
    }
  } catch (notifyErr) {
    ctx.logger.warn(
      { runId: payload.runId, error: String(notifyErr) },
      '[scout] slack notify failed — original run failure still recorded',
    )
  }
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
  const { orgId, icpId, requestedVolume, triggerType } = job.data
  const raw = ctx.db.raw

  // ─── Resolve runId (cron path creates the row inline) ─────────────
  // On-demand path: API created scout_runs row and passed runId.
  // Cron path: BullMQ scheduler payload has no runId — create one now.
  let runId: string
  if (job.data.runId) {
    runId = job.data.runId
  } else {
    const [created] = await raw
      .insert(scoutRunsTable)
      .values({
        orgId,
        icpId,
        status: 'queued',
        triggerType,
        requestedVolume,
      })
      .returning({ id: scoutRunsTable.id })
    runId = created!.id
  }

  // ─── Dedupe: skip if another run for same (org, icp) is already in flight
  // Sprint 5b CP2 — prevents cron and on-demand from racing. Whichever
  // started first owns the slot; the second observation marks itself as
  // 'partial' with errorSummary.code='SKIPPED_DUPLICATE' (we use 'partial'
  // because 'failed' is misleading — this isn't a fault, it's a no-op).
  const otherRunning = await raw
    .select({ id: scoutRunsTable.id })
    .from(scoutRunsTable)
    .where(
      and(
        eq(scoutRunsTable.orgId, orgId),
        eq(scoutRunsTable.icpId, icpId),
        inArray(scoutRunsTable.status, ['queued', 'running']),
        ne(scoutRunsTable.id, runId),
      ),
    )
    .limit(1)

  if (otherRunning.length > 0) {
    await raw
      .update(scoutRunsTable)
      .set({
        status: 'partial',
        finishedAt: new Date(),
        apolloCandidatesFound: 0,
        sqlFilteredCount: 0,
        leadsInsertedCount: 0,
        errorSummary: {
          code: 'SKIPPED_DUPLICATE',
          message: 'Another scout run for this ICP is already in progress',
          category: 'partial',
        },
      })
      .where(eq(scoutRunsTable.id, runId))
    ctx.logger.info(
      { runId, orgId, icpId, otherRunId: otherRunning[0]!.id },
      '[scout] skipping duplicate run, another already in progress',
    )
    return {
      ok: true as const,
      apolloCandidatesFound: 0,
      sqlFilteredCount: 0,
      leadsInsertedCount: 0,
      status: 'partial' as const,
    }
  }

  // ─── Mark run as running ───────────────────────────────────────────
  await raw
    .update(scoutRunsTable)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(scoutRunsTable.id, runId), eq(scoutRunsTable.orgId, orgId)))

  // Bag of context surfaced to error path / Slack notify. Filled inside the
  // try below as soon as we know the ICP name and org webhook url.
  let icpName = '(unknown ICP)'
  let slackWebhookUrl: string | null = null

  try {
    // ─── Load ICP + org metadata (for Slack notify on failure) ────────
    const icpRows = await raw
      .select()
      .from(icpsTable)
      .where(and(eq(icpsTable.id, icpId), eq(icpsTable.orgId, orgId)))
    const icp: IcpRow | undefined = icpRows[0]
    if (!icp) {
      throw new Error(`ICP_NOT_FOUND: icp=${icpId} org=${orgId}`)
    }
    icpName = icp.name

    const [org] = await raw
      .select({ slackWebhookUrl: orgsTable.slackWebhookUrl })
      .from(orgsTable)
      .where(eq(orgsTable.id, orgId))
    slackWebhookUrl = org?.slackWebhookUrl ?? null

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
      // Sprint 5b CP3 — wrap in withTransientRetry. 3 attempts at 1s/2s/4s
      // (overridable via test config). PERMANENT/QUOTA classifications
      // throw immediately without burning the retry budget.
      const result = await withTransientRetry(
        () => apollo.searchPeople({ ...filters, limit: apolloLimit }),
        'apollo',
        {
          maxRetries: overrides.retryMaxAttempts ?? 3,
          backoffBaseMs: overrides.retryBackoffBaseMs,
        },
      )
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
      // Category set here informs both errorSummary persistence + Slack
      // notify routing (see outer catch).
      const category = classifyError(apolloErr, 'apollo')
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
        metadata: { filters, category },
      })
      throw apolloErr
    }

    ctx.logger.info(
      { runId, apolloFound: totalFound, returned: apolloCandidates.length },
      'scout: apollo search complete',
    )

    // ─── Phase 2: SQL fit_score (no slicing yet — LLM phase decides final) ─
    const sqlScored = apolloCandidates
      .map((c) => ({ candidate: c, sqlScore: calculateSQLFitScore(c, icp) }))
      .sort((a, b) => b.sqlScore - a.sqlScore)

    // sqlFilteredCount = candidates that pass into the LLM phase (capped at 100).
    // Semantics shift from Sprint 5a (post-slice insert count) — dashboards
    // should now read leadsInsertedCount for "rows in pipeline" and
    // sqlFilteredCount for "candidates scored".
    const sqlCandidatesForLlm = sqlScored.slice(0, LLM_RERANK_CAP)
    const sqlFilteredCount = sqlCandidatesForLlm.length

    // ─── Phase 3: LLM re-ranking (Sprint 5b, ADR 0002) ────────────────
    // 50 concurrent calls via Promise.all (Decision A — paralelo). Mock-
    // default client → tests run fast. Real client lands Sprint 7 with
    // BYOK per-tenant key resolution (BACKLOG-027).
    const anthropic =
      overrides.anthropic ?? new AnthropicClient({ apiKey: 'mock' })

    let llmRerankedCount = 0
    let llmTotalCostUsd = 0
    let llmFailedCount = 0
    let scoredForInsert: Array<{
      candidate: ApolloPerson
      finalScore: number
      llmResult: ScoreLeadResult | null
    }> = sqlCandidatesForLlm.map(({ candidate, sqlScore }) => ({
      candidate,
      finalScore: sqlScore,
      llmResult: null,
    }))

    if (sqlCandidatesForLlm.length > 0) {
      // Sprint 5b CP3 — Promise.allSettled (not all) so a partial LLM
      // outage degrades to PARTIAL rather than failing the run. Failed
      // candidates fall back to their SQL score so they still rank.
      const llmSettled = await Promise.allSettled(
        sqlCandidatesForLlm.map(({ candidate, sqlScore }) =>
          anthropic.scoreLead({ icp, candidate, sqlScore }),
        ),
      )

      // Bulk insert one cost_event per LLM call (success or failure).
      const costRows = llmSettled.map((settled, idx) => {
        const cand = sqlCandidatesForLlm[idx]!
        if (settled.status === 'fulfilled') {
          const result = settled.value
          return {
            orgId,
            runId,
            agentType: 'scout' as const,
            provider: 'anthropic' as const,
            operationType: 'rerank_score',
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            costUsd: result.costUsd.toFixed(6),
            latencyMs: result.latencyMs,
            success: true,
            metadata: {
              model: anthropic.model,
              candidate_id: cand.candidate.id,
              sql_score: cand.sqlScore,
              llm_score: result.llmScore,
              combined_score: result.combinedScore,
            },
          }
        }
        // Failed path — categorise the failure so dashboards can spot
        // PARTIAL-degraded runs caused by Anthropic outages vs Apollo.
        const reason = settled.reason
        const category = classifyError(reason, 'anthropic')
        return {
          orgId,
          runId,
          agentType: 'scout' as const,
          provider: 'anthropic' as const,
          operationType: 'rerank_score',
          tokensIn: 0,
          tokensOut: 0,
          costUsd: '0.000000',
          latencyMs: 0,
          success: false,
          errorCode:
            reason instanceof Error ? reason.message.slice(0, 200) : String(reason).slice(0, 200),
          metadata: {
            model: anthropic.model,
            candidate_id: cand.candidate.id,
            sql_score: cand.sqlScore,
            category,
          },
        }
      })
      await raw.insert(costEvents).values(costRows)

      llmRerankedCount = llmSettled.filter((s) => s.status === 'fulfilled').length
      llmFailedCount = llmSettled.length - llmRerankedCount
      llmTotalCostUsd = llmSettled.reduce(
        (sum, s) => (s.status === 'fulfilled' ? sum + s.value.costUsd : sum),
        0,
      )

      scoredForInsert = sqlCandidatesForLlm.map(({ candidate, sqlScore }, idx) => {
        const settled = llmSettled[idx]!
        if (settled.status === 'fulfilled') {
          return { candidate, finalScore: settled.value.combinedScore, llmResult: settled.value }
        }
        // Fallback to SQL-only score for failed LLM candidates so the
        // candidate stays in contention; status will be marked 'partial'
        // below to surface that LLM didn't fully cover this run.
        return { candidate, finalScore: sqlScore, llmResult: null }
      })
    }

    // ─── Phase 4: Sort by combined score, take top requestedVolume ────
    const topCandidates = scoredForInsert
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, requestedVolume)

    // ─── Phase 5: Insert leads with ON CONFLICT DO NOTHING ────────────
    let leadsInsertedCount = 0
    // Sprint 6a — lifted to outer scope so Phase 6 (Profiler enqueue) can
    // fan out one profiler job per actually-inserted lead.
    let insertedLeadIds: string[] = []
    if (topCandidates.length > 0) {
      const rowsToInsert = topCandidates.map(({ candidate, finalScore, llmResult }) => ({
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
        fitScore: finalScore,
        fitReasoning: llmResult?.reasoning ?? null,
        fitScoreComputedAt: new Date(),
        rawSignals: {
          apollo_person: candidate as unknown as Record<string, unknown>,
          scout_run_id: runId,
          score_phase: llmResult ? 'combined_v1' : 'sql_v1',
          llm_score: llmResult?.llmScore ?? null,
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

      insertedLeadIds = inserted.map((r) => r.id)
      leadsInsertedCount = inserted.length
    }

    // ─── Mark run as completed or partial ─────────────────────────────
    // Status becomes 'partial' if either:
    //   (a) email/linkedin dedupe skipped some leads (Sprint 5a path)
    //   (b) any LLM call failed (Sprint 5b CP3 path — graceful PARTIAL)
    const dedupCount = topCandidates.length - leadsInsertedCount
    const finalStatus: 'completed' | 'partial' =
      dedupCount > 0 || llmFailedCount > 0 ? 'partial' : 'completed'

    const partialErrorSummary =
      llmFailedCount > 0
        ? {
            code: 'LLM_PARTIAL_FAILURE',
            message: `${llmFailedCount}/${sqlCandidatesForLlm.length} LLM calls failed; falling back to SQL score for those candidates`,
            category: 'partial' as const,
          }
        : null

    await raw
      .update(scoutRunsTable)
      .set({
        status: finalStatus,
        finishedAt: new Date(),
        apolloCandidatesFound: totalFound,
        sqlFilteredCount,
        leadsInsertedCount,
        llmRerankedCount: sqlCandidatesForLlm.length > 0 ? llmRerankedCount : null,
        llmTotalCostUsd: sqlCandidatesForLlm.length > 0 ? llmTotalCostUsd.toFixed(6) : null,
        errorSummary: partialErrorSummary,
      })
      .where(and(eq(scoutRunsTable.id, runId), eq(scoutRunsTable.orgId, orgId)))

    // ─── Phase 6 (Sprint 6a): fan out Profiler per inserted lead ──────
    // Async decoupled — Scout returns 'completed'/'partial' once its own
    // pipeline succeeds, independently of whether Profiler jobs land or run.
    // Per Sprint 6 Decision 4, Scout's status does NOT track Profiler
    // outcomes; Profiler updates leads.status='enriching'→'enriched' on its
    // own schedule. Failed enqueue is non-blocking — leads stay in
    // 'discovered' and a re-run or manual trigger can re-enqueue.
    if (insertedLeadIds.length > 0) {
      const profilerEnqueueResults = await Promise.allSettled(
        insertedLeadIds.map((leadId) =>
          profilerWorker.enqueue({
            leadId,
            orgId,
            scoutRunId: runId,
            triggerType: 'auto_from_scout',
          }),
          // jobId omitted: defineWorker resolves it via Profiler's
          // idempotencyKey → 'profiler-${leadId}', collapsing duplicates.
        ),
      )
      const enqueueSucceeded = profilerEnqueueResults.filter(
        (r) => r.status === 'fulfilled',
      ).length
      const enqueueFailed = profilerEnqueueResults.length - enqueueSucceeded
      ctx.logger.info(
        { runId, totalLeads: insertedLeadIds.length, enqueueSucceeded },
        'scout: profiler enqueue summary',
      )
      if (enqueueFailed > 0) {
        ctx.logger.warn(
          { runId, enqueueFailed, totalLeads: insertedLeadIds.length },
          'scout: profiler enqueue had failures (non-blocking)',
        )
      }
    }

    return {
      ok: true as const,
      apolloCandidatesFound: totalFound,
      sqlFilteredCount,
      leadsInsertedCount,
      status: finalStatus,
    }
  } catch (err) {
    // Sprint 5b CP3 — classify, persist with category, route to Slack if
    // PERMANENT or QUOTA (Decision E: no notify on TRANSIENT-mid-retry or
    // PARTIAL). The withTransientRetry wrapper has already exhausted retries
    // for transient errors by this point, so anything reaching here is
    // either PERMANENT/QUOTA from the start or a TRANSIENT escalated after
    // exhaustion — in all three cases the founder needs to know.
    const message = err instanceof Error ? err.message : String(err)
    // TaggedAgentError carries the code in `tag`; prefer it over message
    // string-splitting (the message format isn't always "CODE: text").
    const code =
      err instanceof TaggedAgentError
        ? err.tag
        : message.includes(':')
          ? message.split(':')[0]!.trim()
          : 'UNKNOWN'
    // Provider hint: ICP_NOT_FOUND and similar internal errors don't have
    // a clean provider mapping; classifyError handles this by defaulting
    // to transient — but for the persisted summary we record the literal
    // category instead so dashboards show a real bucket.
    const inferredProvider = message.toLowerCase().includes('anthropic')
      ? 'anthropic'
      : 'apollo'
    let category = classifyError(err, inferredProvider)
    // Internal-error codes (ICP_NOT_FOUND, SCOUT_CRON_ORG_NOT_FOUND, etc)
    // get re-labelled PERMANENT — the worker won't recover by retrying.
    if (code === 'ICP_NOT_FOUND' || code === 'SCOUT_CRON_ORG_NOT_FOUND') {
      category = 'permanent'
    }

    await raw
      .update(scoutRunsTable)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorSummary: { code, message: message.slice(0, 500), category },
      })
      .where(and(eq(scoutRunsTable.id, runId), eq(scoutRunsTable.orgId, orgId)))

    ctx.logger.error({ runId, code, category, error: message }, 'scout: run failed')

    // Slack notify — only on PERMANENT or QUOTA, per Decision E.
    if (category === 'permanent' || category === 'quota') {
      await notifySlackIfConfigured(
        ctx,
        slackWebhookUrl,
        {
          kind: category === 'quota' ? 'quota' : 'failure',
          runId,
          icpName,
          error: { category, message: message.slice(0, 200), code },
          provider: inferredProvider,
        },
        overrides.slack,
      )
    }

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
  // Cron-fired jobs (no runId in payload) get undefined here — BullMQ
  // auto-generates a jobId per firing, which is exactly what we want.
  idempotencyKey: (job) => (job.runId ? `scout-${job.runId}` : `scout-cron-${job.orgId}-${job.icpId}-${Date.now()}`),
  process: (job, ctx) => processScoutJob(job, ctx),
})
