import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  costEvents,
  icps as icpsTable,
  leadDossiers as leadDossiersTable,
  leads as leadsTable,
  orgs as orgsTable,
} from '@spleed/db'
import { AnthropicClient, type IcpShape } from '@spleed/integrations/anthropic'
import { SlackWebhookClient } from '@spleed/integrations/slack'
import { VercelBrowserClient } from '@spleed/integrations/vercel-browser'
import {
  extractCompanyWebsiteSignals,
  type CompanyWebsiteSignalsWithIds,
  type LeadShape,
} from '../agents/profiler'
import { classifyError, TaggedAgentError, withTransientRetry } from '../runtime/errors'
import type { WorkerContext } from './context'
import { defineWorker } from './define'

/**
 * Sprint 6a Profiler worker — enriches one lead at a time from the
 * company-website source (decision 2 of 8: 3-source pipeline staged
 * across 6a/6b; LinkedIn + Google News land in Sprint 6b).
 *
 * Pipeline: load lead+ICP → leads.status='enriching' → upsert empty
 * dossier → Vercel scrape → Anthropic extraction → derive pains/interests/
 * recentChanges → leads.status='enriched'.
 *
 * Failure path reverts leads.status='discovered' (retry-able) and deletes
 * the partial dossier so the next attempt starts clean.
 *
 * Idempotency: jobId = `profiler-${leadId}` so Scout's bulk enqueue + a
 * concurrent manual trigger collapse to one job per lead (BullMQ no-op
 * on duplicate jobId).
 */
const ProfilerJobSchema = z.object({
  leadId: z.string().uuid(),
  orgId: z.string().uuid(),
  /**
   * Optional traceability back to the Scout run that produced the lead.
   * Persisted on cost_events.run_id so per-run cost rollups include
   * Profiler spend (not just Scout's Apollo + Anthropic).
   */
  scoutRunId: z.string().uuid().optional(),
  /**
   * Always provided by callers (Scout enqueue, manual API trigger, cron
   * scheduler). NOT defaulted — `.default()` would make zod's input type
   * accept `undefined`, which the defineWorker generic constraint
   * (`z.ZodType<TJob>` with TJob having a required triggerType) rejects.
   * Mirrors scout.worker.ts ScoutJobSchema convention.
   */
  triggerType: z.enum(['auto_from_scout', 'manual', 'cron']),
})

export type ProfilerJob = z.infer<typeof ProfilerJobSchema>

export interface ProfilerResult {
  ok: true
  leadId: string
  /**
   * - 'enriched' — dossier populated (full or empty signals on graceful
   *   degradation like missing companyDomain)
   * - 'skipped'  — non-error no-op (e.g. lead.icpId is NULL); leaves
   *   leads.status untouched so a future trigger can succeed
   */
  status: 'enriched' | 'skipped'
  hookCount: number
  costUsd: number
}

/**
 * Test-only injection point — mirrors the scout worker's
 * ProcessScoutJobOverrides pattern so tests can swap in throwing/
 * deterministic clients without spinning Redis or mutating env vars.
 */
export interface ProcessProfilerJobOverrides {
  vercel?: VercelBrowserClient
  anthropic?: AnthropicClient
  slack?: SlackWebhookClient
  retryBackoffBaseMs?: number
  retryMaxAttempts?: number
}

/**
 * Profiler equivalent of scout's notifySlackIfConfigured. Uses sendText
 * (not sendScoutFailure) so we can format a Profiler-specific message
 * without widening the typed payloads in @spleed/integrations/slack.
 */
async function notifySlackIfConfigured(
  ctx: WorkerContext,
  slackWebhookUrl: string | null,
  payload: {
    kind: 'failure' | 'quota'
    leadId: string
    leadName: string
    company: string
    error: { category: string; message: string; code: string }
    provider: 'vercel_browser' | 'anthropic'
  },
  override?: SlackWebhookClient,
): Promise<void> {
  if (!slackWebhookUrl) return
  try {
    const client = override ?? new SlackWebhookClient(slackWebhookUrl)
    const header =
      payload.kind === 'quota'
        ? `:warning: *${payload.provider.toUpperCase()} quota exhausted* (Profiler)`
        : ':rotating_light: *Profiler failure*'
    const text = [
      header,
      `Lead: \`${payload.leadName}\` — ${payload.company}`,
      `Category: \`${payload.error.category}\`${payload.error.code ? ` (${payload.error.code})` : ''}`,
      `Message: ${payload.error.message}`,
      `Lead ID: \`${payload.leadId}\``,
    ].join('\n')
    await client.sendText(text)
  } catch (notifyErr) {
    ctx.logger.warn(
      { leadId: payload.leadId, error: String(notifyErr) },
      '[profiler] slack notify failed — original failure still recorded',
    )
  }
}

/**
 * Map raw extracted signals + hookIds onto the lead_dossiers columns.
 * Sprint 6a's mapping is intentionally simple — Sprint 6b adds the
 * structured-pipeline synthesis call that blends multi-source signals
 * (currently just one source = whatever the LLM returned wins).
 */
function deriveDossierFields(
  signals: CompanyWebsiteSignalsWithIds,
  sourceUrl: string,
): {
  pains: Array<{
    description: string
    sourceUrl: string
    sourceQuote: string
    confidence: number
    recencyDaysAgo: number
  }>
  interests: Array<{
    topic: string
    sourceUrl: string
    confidence: number
    signalStrength: 'weak' | 'medium' | 'strong'
  }>
  recentChanges: Array<{
    kind: string
    description: string
    sourceUrl: string
    occurredAt: string
  }>
  confidenceScore: number
} {
  // Top 3 pain_signals → dossier.pains. We don't have a separate "quote"
  // for inferred pains (the LLM summarized them); reuse description so
  // the dossier shape stays uniform across hook_candidates (which DO
  // carry quotes) and pain_signals.
  const pains = signals.pain_signals.slice(0, 3).map((description) => ({
    description,
    sourceUrl,
    sourceQuote: description,
    confidence: 0.7,
    recencyDaysAgo: 0,
  }))

  // Interests: derive from hook_candidates. Each hook is essentially a
  // pre-built outreach angle; Composer (Sprint 7) reads interests + hooks
  // together to pick a per-lead variant.
  const interests = signals.hook_candidates.slice(0, 5).map((hc) => ({
    topic: hc.hook,
    sourceUrl,
    confidence: hc.confidence,
    signalStrength:
      hc.confidence > 0.85
        ? ('strong' as const)
        : hc.confidence > 0.7
          ? ('medium' as const)
          : ('weak' as const),
  }))

  // recent_news + growth_signals both qualify as recentChanges entries.
  // occurredAt = now (we don't have a real timestamp in the source; Sprint
  // 6b's news source will parse actual dates).
  const nowIso = new Date().toISOString()
  const recentChanges = [
    ...signals.recent_news.map((description) => ({
      kind: 'news',
      description,
      sourceUrl,
      occurredAt: nowIso,
    })),
    ...signals.growth_signals.slice(0, 3).map((description) => ({
      kind: 'growth_signal',
      description,
      sourceUrl,
      occurredAt: nowIso,
    })),
  ]

  const confidenceScore =
    signals.hook_candidates.length > 0
      ? signals.hook_candidates.reduce((sum, hc) => sum + hc.confidence, 0) /
        signals.hook_candidates.length
      : 0

  return { pains, interests, recentChanges, confidenceScore }
}

/**
 * Core Profiler processor. Extracted from defineWorker so tests can drive
 * the full DB pipeline without Redis. Production callers always route via
 * `profilerWorker.start()`.
 */
export async function processProfilerJob(
  job: { data: ProfilerJob },
  ctx: WorkerContext,
  overrides: ProcessProfilerJobOverrides = {},
): Promise<ProfilerResult> {
  const { leadId, orgId, scoutRunId } = job.data
  const raw = ctx.db.raw

  // ─── Load lead + ICP ──────────────────────────────────────────────
  const [lead] = await raw
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))

  if (!lead) {
    throw new TaggedAgentError(
      'LEAD_NOT_FOUND',
      `Lead ${leadId} not found in org ${orgId}`,
      { classification: 'permanent' },
    )
  }

  // No ICP attached — Profiler has no anchor for extraction. Don't fail;
  // skip cleanly so a later manual ICP assignment + re-trigger can succeed.
  // This is rare under Scout (Sprint 5 always sets icpId) but expected for
  // manual ingest (BACKLOG-018, Sprint 7-8) before ICP routing exists.
  if (!lead.icpId) {
    ctx.logger.info({ leadId }, '[profiler] skipping — lead has no icpId')
    return { ok: true, leadId, status: 'skipped', hookCount: 0, costUsd: 0 }
  }

  const [icp] = await raw
    .select()
    .from(icpsTable)
    .where(and(eq(icpsTable.id, lead.icpId), eq(icpsTable.orgId, orgId)))

  if (!icp) {
    throw new TaggedAgentError(
      'ICP_NOT_FOUND',
      `ICP ${lead.icpId} not found in org ${orgId}`,
      { classification: 'permanent' },
    )
  }

  // ─── Slack webhook lookup (for failure notify) ────────────────────
  const [org] = await raw
    .select({ slackWebhookUrl: orgsTable.slackWebhookUrl })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId))
  const slackWebhookUrl = org?.slackWebhookUrl ?? null

  // ─── Mark leads.status='enriching' ────────────────────────────────
  await raw
    .update(leadsTable)
    .set({ status: 'enriching', updatedAt: new Date() })
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))

  // ─── Upsert empty dossier row (PK = leadId) ───────────────────────
  // Idempotent: re-runs land on the same row (PK conflict → update).
  // Sprint 6 Decision 6 says "once and forget" — a re-trigger overwrites
  // the prior enrichment rather than appending. Smart refresh policy is
  // BACKLOG-038 (Sprint 12+).
  await raw
    .insert(leadDossiersTable)
    .values({
      leadId,
      orgId,
      enrichedBy: 'profiler_agent_v1',
      isStale: false,
    })
    .onConflictDoUpdate({
      target: leadDossiersTable.leadId,
      set: {
        enrichedBy: 'profiler_agent_v1',
        isStale: false,
        updatedAt: new Date(),
      },
    })

  try {
    // ─── No domain → graceful empty enrichment ────────────────────────
    // Manual-ingest leads (Sprint 8 BACKLOG-018) may arrive without
    // companyDomain. Rather than fail, mark them 'enriched' with an empty
    // dossier so they still flow into Composer's queue — Composer's lead-
    // detail UI surfaces "thin enrichment" so the founder can paste a
    // domain and re-trigger.
    if (!lead.companyDomain) {
      await raw
        .update(leadsTable)
        .set({
          status: 'enriched',
          enrichedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))
      ctx.logger.info({ leadId }, '[profiler] enriched with empty dossier — no companyDomain')
      return { ok: true, leadId, status: 'enriched', hookCount: 0, costUsd: 0 }
    }

    // ─── Phase 1: Vercel browser scrape ───────────────────────────────
    const vercel = overrides.vercel ?? new VercelBrowserClient()
    const scrapeStart = Date.now()
    let scrapeResult
    try {
      scrapeResult = await withTransientRetry(
        () => vercel.scrapeCompanyWebsite(lead.companyDomain!),
        'vercel_browser',
        {
          maxRetries: overrides.retryMaxAttempts ?? 3,
          backoffBaseMs: overrides.retryBackoffBaseMs,
        },
      )
      await raw.insert(costEvents).values({
        orgId,
        runId: scoutRunId ?? null,
        agentType: 'profiler',
        provider: 'vercel_browser',
        operationType: 'scrape_company',
        costUsd: scrapeResult.costUsd.toFixed(6),
        latencyMs: Date.now() - scrapeStart,
        success: true,
        metadata: {
          lead_id: leadId,
          domain: lead.companyDomain,
          final_url: scrapeResult.metadata.finalUrl,
          credits: scrapeResult.creditsConsumed,
        },
      })
    } catch (scrapeErr) {
      const category = classifyError(scrapeErr, 'vercel_browser')
      await raw.insert(costEvents).values({
        orgId,
        runId: scoutRunId ?? null,
        agentType: 'profiler',
        provider: 'vercel_browser',
        operationType: 'scrape_company',
        costUsd: '0.000000',
        latencyMs: Date.now() - scrapeStart,
        success: false,
        errorCode:
          scrapeErr instanceof Error ? scrapeErr.message.slice(0, 200) : 'UNKNOWN',
        metadata: { lead_id: leadId, domain: lead.companyDomain, category },
      })
      throw scrapeErr
    }

    // ─── Phase 2: Anthropic extraction ────────────────────────────────
    const anthropic = overrides.anthropic ?? new AnthropicClient({ apiKey: 'mock' })
    const leadShape: LeadShape = {
      fullName: lead.fullName,
      firstName: lead.firstName,
      lastName: lead.lastName,
      company: lead.company,
      role: lead.role,
      companyDomain: lead.companyDomain,
      email: lead.email,
      linkedinUrl: lead.linkedinUrl,
    }
    const icpShape: IcpShape = {
      name: icp.name,
      definitionNaturalLanguage: icp.definitionNaturalLanguage,
      parsedFilters: icp.parsedFilters,
    }

    let extractResult
    try {
      extractResult = await extractCompanyWebsiteSignals({
        pageContent: scrapeResult.pageContent,
        lead: leadShape,
        icp: icpShape,
        anthropicClient: anthropic,
      })
      await raw.insert(costEvents).values({
        orgId,
        runId: scoutRunId ?? null,
        agentType: 'profiler',
        provider: 'anthropic',
        operationType: 'extraction_company_website',
        tokensIn: extractResult.tokensIn,
        tokensOut: extractResult.tokensOut,
        costUsd: extractResult.costUsd.toFixed(6),
        latencyMs: extractResult.latencyMs,
        success: true,
        metadata: {
          lead_id: leadId,
          model: anthropic.model,
          stage: extractResult.signals.company_stage,
          hook_count: extractResult.signals.hook_candidates.length,
        },
      })
    } catch (extractErr) {
      const category = classifyError(extractErr, 'anthropic')
      await raw.insert(costEvents).values({
        orgId,
        runId: scoutRunId ?? null,
        agentType: 'profiler',
        provider: 'anthropic',
        operationType: 'extraction_company_website',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: '0.000000',
        latencyMs: 0,
        success: false,
        errorCode:
          extractErr instanceof Error
            ? extractErr.message.slice(0, 200)
            : 'UNKNOWN',
        metadata: { lead_id: leadId, model: anthropic.model, category },
      })
      throw extractErr
    }

    // ─── Phase 3: Persist dossier ─────────────────────────────────────
    const derived = deriveDossierFields(
      extractResult.signals,
      scrapeResult.metadata.finalUrl,
    )

    await raw
      .update(leadDossiersTable)
      .set({
        pains: derived.pains,
        interests: derived.interests,
        recentChanges: derived.recentChanges,
        // rawSignals carries the full extraction so Sprint 6b's structured-
        // pipeline synthesis (3 extractions + 1 synthesis) can join across
        // sources. Sprint 6a only has one source; subsequent sources will
        // namespace under linkedinSignals / newsSignals.
        rawSignals: { companyWebsiteSignals: extractResult.signals },
        confidenceScore: derived.confidenceScore,
        isStale: false,
        enrichedBy: 'profiler_agent_v1',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(leadDossiersTable.leadId, leadId),
          eq(leadDossiersTable.orgId, orgId),
        ),
      )

    // ─── Phase 4: Mark lead as enriched ───────────────────────────────
    await raw
      .update(leadsTable)
      .set({
        status: 'enriched',
        enrichedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))

    const totalCostUsd = scrapeResult.costUsd + extractResult.costUsd
    ctx.logger.info(
      {
        leadId,
        company: lead.company,
        hookCount: extractResult.signals.hook_candidates.length,
        stage: extractResult.signals.company_stage,
        costUsd: totalCostUsd,
      },
      '[profiler] lead enriched',
    )

    return {
      ok: true,
      leadId,
      status: 'enriched',
      hookCount: extractResult.signals.hook_candidates.length,
      costUsd: totalCostUsd,
    }
  } catch (err) {
    // ─── Failure path ─────────────────────────────────────────────────
    // Revert leads.status='discovered' (retry-able). Delete partial dossier
    // so the next run starts clean — we deliberately don't keep half-filled
    // dossiers around (Sprint 6 decision 6: once-and-forget).
    const message = err instanceof Error ? err.message : String(err)
    const code =
      err instanceof TaggedAgentError
        ? err.tag
        : message.includes(':')
          ? message.split(':')[0]!.trim()
          : 'UNKNOWN'
    const inferredProvider: 'anthropic' | 'vercel_browser' = message
      .toLowerCase()
      .includes('anthropic')
      ? 'anthropic'
      : 'vercel_browser'
    let category = classifyError(err, inferredProvider)
    if (code === 'LEAD_NOT_FOUND' || code === 'ICP_NOT_FOUND') {
      category = 'permanent'
    }

    await raw
      .delete(leadDossiersTable)
      .where(
        and(
          eq(leadDossiersTable.leadId, leadId),
          eq(leadDossiersTable.orgId, orgId),
        ),
      )

    await raw
      .update(leadsTable)
      .set({ status: 'discovered', updatedAt: new Date() })
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))

    ctx.logger.error(
      { leadId, code, category, error: message },
      '[profiler] enrichment failed',
    )

    if (category === 'permanent' || category === 'quota') {
      await notifySlackIfConfigured(
        ctx,
        slackWebhookUrl,
        {
          kind: category === 'quota' ? 'quota' : 'failure',
          leadId,
          leadName: lead.fullName,
          company: lead.company,
          error: { category, message: message.slice(0, 200), code },
          provider: inferredProvider,
        },
        overrides.slack,
      )
    }

    throw err
  }
}

export const profilerWorker = defineWorker<ProfilerJob, ProfilerResult>({
  queueName: 'profiler',
  jobSchema: ProfilerJobSchema,
  // Profiler is I/O-bound (browser scrape + LLM call) — push concurrency
  // higher than Scout's CPU-leaning re-rank phase. Tune in Sprint 12
  // hardening based on real Redis pressure.
  concurrency: 4,
  idempotencyKey: (job) => `profiler-${job.leadId}`,
  process: (job, ctx) => processProfilerJob(job, ctx),
})
