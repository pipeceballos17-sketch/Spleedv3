import { and, eq } from 'drizzle-orm'
import type { Logger } from 'pino'
import { z } from 'zod'
import {
  costEvents,
  icps as icpsTable,
  leadDossiers as leadDossiersTable,
  leads as leadsTable,
  orgs as orgsTable,
} from '@spleed/db'
import {
  AnthropicClient,
  type DeepResearchOutput,
  type IcpShape,
  type ProfilerSourceName,
} from '@spleed/integrations/anthropic'
import { ApifyClient } from '@spleed/integrations/apify'
import {
  BrowserOrchestrator,
  createDefaultBrowserOrchestrator,
} from '@spleed/integrations/browser'
import { SlackWebhookClient } from '@spleed/integrations/slack'
import {
  VercelBrowserClient,
  type CompanyWebsitePageContent,
} from '@spleed/integrations/vercel-browser'
import { normalizePhone } from '@spleed/shared'
import { DeepResearchAgent } from '../agents/deep-research'
import {
  extractCompanyWebsiteSignals,
  extractLinkedinSignals,
  extractNewsSignals,
  synthesizeDossier,
  synthesizeFinalDossier,
  type CompanyWebsiteSignalsWithIds,
  type LeadShape,
  type SynthesisSourceInput,
  type SynthesizedDossier,
} from '../agents/profiler'
import { classifyError, TaggedAgentError, withTransientRetry } from '../runtime/errors'
import {
  uploadScreenshotsToStorage,
  type UploadedScreenshot,
} from '../storage'
import type { WorkerContext } from './context'
import { defineWorker } from './define'

/**
 * Sprint 6b Profiler worker. Pipeline: load lead+ICP → upsert dossier +
 * leads.status='enriching' → run 3 sources in parallel (Promise.allSettled)
 * → synthesize → write dossier → leads.status='enriched'.
 *
 * Sources (per Sprint 6 decisions 1, 2, 7):
 *   1. company_website — Vercel agent-browser scrape + Anthropic extraction
 *   2. linkedin        — Apify profile + posts + Anthropic extraction
 *   3. news            — Vercel agent-browser Google News + Anthropic extraction
 *
 * Per-source helpers capture annotated screenshots inline (confidence > 0.7
 * hooks) while the scrape session is active, upload to Supabase Storage
 * (mock-default), and return evidence URLs for the dossier.
 *
 * cost_events: full enrichment writes 8 rows
 *   - vercel_browser × 2 (company website scrape, news scrape; each
 *     includes inline screenshot cost in metadata)
 *   - apify × 2 (linkedin profile, linkedin posts)
 *   - anthropic × 4 (3 source extractions + 1 synthesis)
 *
 * Failure modes:
 *   - 0 sources succeed → leads.status reverts to 'discovered',
 *     dossier DELETED, Slack notify PERMANENT (Sprint 5b classifier)
 *   - 1-2 sources succeed → leads.status='enriched' (partial), dossier
 *     populated with what we have, rawSignals.partialEnrichment=true
 *   - 3 sources succeed → leads.status='enriched' full
 */
const ProfilerJobSchema = z.object({
  leadId: z.string().uuid(),
  orgId: z.string().uuid(),
  scoutRunId: z.string().uuid().optional(),
  /**
   * Sprint 7a — 'manual_reingest' added for re-enqueue path from POST
   * /api/leads/ingest when an existing 'discovered' lead is re-ingested
   * by the founder. Distinct from 'manual' (initial run-lead trigger)
   * so Hermes can attribute conversion to the originating ingest channel.
   */
  triggerType: z.enum(['auto_from_scout', 'manual', 'manual_reingest', 'cron']),
})

export type ProfilerJob = z.infer<typeof ProfilerJobSchema>

export interface ProfilerResult {
  ok: true
  leadId: string
  /**
   * - 'enriched' — at least 1 source succeeded; dossier populated
   *   (full or partial — see partialEnrichment flag)
   * - 'skipped'  — no-op (lead.icpId NULL); leads.status untouched
   */
  status: 'enriched' | 'skipped'
  /** Total hooks in the synthesized dossier (post-dedupe). */
  hookCount: number
  /** Sum of all cost_events (8 Sprint 6b baseline + 4 Phase 7/8 when deep research runs). */
  costUsd: number
  /** Names of sources that produced signals. */
  successfulSources: ProfilerSourceName[]
  /** Names of sources that failed extraction. */
  failedSources: ProfilerSourceName[]
  /** Sprint 7b — Phase 7 deep research fired (initial confidence < threshold). */
  phase7Triggered: boolean
  /** Sprint 7b — Phase 7 ran but threw; fell back to Phase 6 synthesis. */
  phase7Failed: boolean
  /** Sprint 7b — Phase 8 final synthesis ran (only when Phase 7 produced output). */
  phase8Ran: boolean
}

export interface ProcessProfilerJobOverrides {
  vercel?: VercelBrowserClient
  apify?: ApifyClient
  anthropic?: AnthropicClient
  slack?: SlackWebhookClient
  /** Sprint 7b — inject a custom DeepResearchAgent (tests force throw/empty). */
  deepResearchAgent?: DeepResearchAgent
  /** Sprint 9 CP2 — inject a custom BrowserOrchestrator (tests force a block). */
  browser?: BrowserOrchestrator
  retryBackoffBaseMs?: number
  retryMaxAttempts?: number
  /** Force storage helper mock mode regardless of env (tests use this). */
  storageMockMode?: boolean
}

/**
 * Sprint 7b — Phase 7 deep research fires only when the Phase 6 initial
 * synthesis confidence is below this bar. High-confidence leads (rich
 * initial 3-source signal) skip the expensive Opus research entirely.
 * Per-ICP override deferred to BACKLOG-043 (Sprint 8+).
 */
const DEEP_RESEARCH_THRESHOLD = 0.75

/** Anthropic native web tool unit costs (mirror integrations mock constants). */
const WEB_SEARCH_COST_USD = 0.01
const WEB_FETCH_COST_USD = 0.001

/**
 * Slack notify helper — Profiler-specific failure message. Uses sendText
 * (not sendScoutFailure) so the wording fits Profiler context without
 * widening typed payloads. Always swallows its own failures (Slack
 * downtime must not crash the worker).
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
    provider: 'vercel_browser' | 'anthropic' | 'apify' | 'profiler'
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

// ─── Confidence-threshold gate for screenshot capture ────────────────

/** Sprint 6 Decision 5 — only annotated-screenshot hooks above this bar. */
const SCREENSHOT_CONFIDENCE_THRESHOLD = 0.7

// ─── Per-source helpers (Sprint 6b structured pipeline) ─────────────

interface ScrapeAndExtractBaseContext {
  lead: LeadShape & { id: string }
  icp: IcpShape
  orgId: string
  scoutRunId: string | null
  anthropic: AnthropicClient
  raw: WorkerContext['db']['raw']
  logger: Logger
  storageMockMode?: boolean
  retryBackoffBaseMs?: number
  retryMaxAttempts?: number
}

interface SourceExtractionResult {
  sourceName: ProfilerSourceName
  signals: CompanyWebsiteSignalsWithIds
  /** Screenshots captured for hooks with confidence > threshold. */
  evidenceUrls: UploadedScreenshot[]
  /** Sum of scrape, screenshot, and extraction costs for this source. */
  totalCostUsd: number
  /**
   * Sprint 9 — raw phone surfaced by this source (LinkedIn contact / company
   * website contact line), if any. Normalized + written to leads.phone by the
   * worker. Undefined when the source carries no phone.
   */
  phone?: string | null
}

/**
 * Capture annotated screenshots for above-threshold hooks, upload to
 * Storage. Returns evidence URLs the dossier writer aggregates.
 * Promise.allSettled per hook so a single screenshot failure doesn't
 * break extraction.
 */
async function captureAndUploadScreenshots(args: {
  hooks: CompanyWebsiteSignalsWithIds['hook_candidates']
  sourceUrl: string
  sourceType: ProfilerSourceName
  orgId: string
  leadId: string
  vercel: VercelBrowserClient
  storageMockMode?: boolean
  logger: Logger
}): Promise<{ evidenceUrls: UploadedScreenshot[]; screenshotCostUsd: number }> {
  const eligible = args.hooks.filter((h) => h.confidence > SCREENSHOT_CONFIDENCE_THRESHOLD)
  if (eligible.length === 0) {
    return { evidenceUrls: [], screenshotCostUsd: 0 }
  }

  const captureResults = await Promise.allSettled(
    eligible.map((hook) =>
      args.vercel.takeAnnotatedScreenshot({
        url: args.sourceUrl,
        annotate: true,
      }).then((cap) => ({ hookId: hook.hookId, ...cap })),
    ),
  )

  // Aggregate successes and screenshot cost.
  let screenshotCostUsd = 0
  const successful: Array<{ hookId: string; imageBytes: Buffer; mimeType: string }> = []
  for (const result of captureResults) {
    if (result.status === 'fulfilled') {
      screenshotCostUsd += result.value.costUsd
      successful.push({
        hookId: result.value.hookId,
        imageBytes: result.value.imageBytes,
        mimeType: result.value.mimeType,
      })
    } else {
      args.logger.warn(
        { sourceType: args.sourceType, error: String(result.reason) },
        '[profiler] screenshot capture failed (non-blocking)',
      )
    }
  }

  if (successful.length === 0) {
    return { evidenceUrls: [], screenshotCostUsd }
  }

  const uploaded = await uploadScreenshotsToStorage({
    screenshots: successful,
    orgId: args.orgId,
    leadId: args.leadId,
    sourceType: args.sourceType,
    mockMode: args.storageMockMode,
  })

  return { evidenceUrls: uploaded, screenshotCostUsd }
}

async function scrapeAndExtractCompanyWebsite(
  ctx: ScrapeAndExtractBaseContext & {
    vercel: VercelBrowserClient
    browser: BrowserOrchestrator
  },
): Promise<SourceExtractionResult> {
  if (!ctx.lead.companyDomain) {
    // Caller should have filtered this out — defensive only.
    throw new TaggedAgentError(
      'NO_COMPANY_DOMAIN',
      'companyDomain missing for company-website source',
      { classification: 'permanent' },
    )
  }
  const domain = ctx.lead.companyDomain

  // ─── Scrape (Sprint 9 CP2: tier-orchestrated HTTP-direct → Vercel) ──
  const scrapeRes = await ctx.browser.scrape({
    url: domain,
    mockShape: 'CompanyWebsitePageContent',
  })

  // One cost_event per tier attempt (browser_scrape_<tier>). provider=
  // 'vercel_browser' is the browser provider family — metadata.tier carries the
  // precise tier (the cost_provider enum has no per-tier values yet; BACKLOG-064
  // adds them when per-provider billing analysis lands). escalated_from links a
  // retry to the tier that bounced it. foldScreenshotUsd is added to the
  // successful tier's row so the dossier's screenshot cost stays accounted.
  const browserCostRows = (foldScreenshotUsd: number): Array<typeof costEvents.$inferInsert> =>
    scrapeRes.attempts.map((a, i) => ({
      orgId: ctx.orgId,
      runId: ctx.scoutRunId ?? null,
      agentType: 'profiler' as const,
      provider: 'vercel_browser' as const,
      operationType: `browser_scrape_${a.tier}`,
      costUsd: (a.costUsd + (a.success ? foldScreenshotUsd : 0)).toFixed(6),
      latencyMs: a.latencyMs,
      success: a.success,
      errorCode: a.success ? null : a.blockedBy ?? 'unknown',
      metadata: {
        lead_id: ctx.lead.id,
        url_domain: domain,
        tier: a.tier,
        ...(a.blockedBy ? { blocked_by: a.blockedBy } : {}),
        ...(i > 0 ? { escalated_from: scrapeRes.attempts[i - 1]!.tier } : {}),
        ...(a.success && foldScreenshotUsd > 0 ? { screenshot_cost_usd: foldScreenshotUsd } : {}),
      },
    }))

  if (!scrapeRes.success) {
    await ctx.raw.insert(costEvents).values(browserCostRows(0))
    throw new TaggedAgentError(
      'WEBSITE_SCRAPE_BLOCKED',
      `company website scrape blocked (blocked_by=${scrapeRes.blockedBy}) after ${scrapeRes.attempts.length} tier(s)`,
      { classification: 'permanent' },
    )
  }
  const pageContent = scrapeRes.data as CompanyWebsitePageContent

  // ─── Extract ──────────────────────────────────────────────────────
  let extractResult
  try {
    extractResult = await extractCompanyWebsiteSignals({
      pageContent,
      lead: ctx.lead,
      icp: ctx.icp,
      anthropicClient: ctx.anthropic,
    })
  } catch (extractErr) {
    const category = classifyError(extractErr, 'anthropic')
    // Persist the (successful) browser attempts AND the extraction failure.
    await ctx.raw.insert(costEvents).values([
      ...browserCostRows(0),
      {
        orgId: ctx.orgId,
        runId: ctx.scoutRunId ?? null,
        agentType: 'profiler',
        provider: 'anthropic',
        operationType: 'extraction_company_website',
        costUsd: '0.000000',
        latencyMs: 0,
        success: false,
        errorCode: extractErr instanceof Error ? extractErr.message.slice(0, 200) : 'UNKNOWN',
        metadata: { lead_id: ctx.lead.id, category },
      },
    ])
    throw extractErr
  }

  // ─── Per-hook screenshots ─────────────────────────────────────────
  const { evidenceUrls, screenshotCostUsd } = await captureAndUploadScreenshots({
    hooks: extractResult.signals.hook_candidates,
    sourceUrl: `https://${domain}`,
    sourceType: 'company_website',
    orgId: ctx.orgId,
    leadId: ctx.lead.id,
    vercel: ctx.vercel,
    storageMockMode: ctx.storageMockMode,
    logger: ctx.logger,
  })

  // ─── cost_events (per-tier browser_scrape rows + extraction) ──────
  await ctx.raw.insert(costEvents).values([
    ...browserCostRows(screenshotCostUsd),
    {
      orgId: ctx.orgId,
      runId: ctx.scoutRunId ?? null,
      agentType: 'profiler',
      provider: 'anthropic',
      operationType: 'extraction_company_website',
      tokensIn: extractResult.tokensIn,
      tokensOut: extractResult.tokensOut,
      costUsd: extractResult.costUsd.toFixed(6),
      latencyMs: extractResult.latencyMs,
      success: true,
      metadata: {
        lead_id: ctx.lead.id,
        model: ctx.anthropic.model,
        stage: extractResult.signals.company_stage,
        hook_count: extractResult.signals.hook_candidates.length,
      },
    },
  ])

  return {
    sourceName: 'company_website',
    signals: extractResult.signals,
    evidenceUrls,
    totalCostUsd: scrapeRes.costUsd + screenshotCostUsd + extractResult.costUsd,
    phone: pageContent.contactPhone ?? null,
  }
}

async function scrapeAndExtractLinkedin(
  ctx: ScrapeAndExtractBaseContext & {
    vercel: VercelBrowserClient
    apify: ApifyClient
  },
): Promise<SourceExtractionResult> {
  if (!ctx.lead.linkedinUrl) {
    throw new TaggedAgentError(
      'NO_LINKEDIN_URL',
      'linkedinUrl missing for linkedin source',
      { classification: 'permanent' },
    )
  }

  // ─── Parallel profile + posts scrape ──────────────────────────────
  // Both are Apify actors — independent calls. Fail-fast inside the
  // helper: either both succeed or the source fails.
  const apifyStart = Date.now()
  let profileResult, postsResult
  try {
    ;[profileResult, postsResult] = await Promise.all([
      withTransientRetry(
        () => ctx.apify.scrapeLinkedinProfile(ctx.lead.linkedinUrl!),
        'apify',
        {
          maxRetries: ctx.retryMaxAttempts ?? 3,
          backoffBaseMs: ctx.retryBackoffBaseMs,
        },
      ),
      withTransientRetry(
        () => ctx.apify.scrapeLinkedinPosts(ctx.lead.linkedinUrl!, { limit: 5 }),
        'apify',
        {
          maxRetries: ctx.retryMaxAttempts ?? 3,
          backoffBaseMs: ctx.retryBackoffBaseMs,
        },
      ),
    ])
  } catch (apifyErr) {
    const category = classifyError(apifyErr, 'apify')
    await ctx.raw.insert(costEvents).values({
      orgId: ctx.orgId,
      runId: ctx.scoutRunId ?? null,
      agentType: 'profiler',
      provider: 'apify',
      operationType: 'scrape_linkedin',
      costUsd: '0.000000',
      latencyMs: Date.now() - apifyStart,
      success: false,
      errorCode: apifyErr instanceof Error ? apifyErr.message.slice(0, 200) : 'UNKNOWN',
      metadata: { lead_id: ctx.lead.id, linkedin_url: ctx.lead.linkedinUrl, category },
    })
    throw apifyErr
  }

  // ─── Extract ──────────────────────────────────────────────────────
  let extractResult
  try {
    extractResult = await extractLinkedinSignals({
      profile: profileResult.profile,
      posts: postsResult.posts,
      lead: ctx.lead,
      icp: ctx.icp,
      anthropicClient: ctx.anthropic,
    })
  } catch (extractErr) {
    const category = classifyError(extractErr, 'anthropic')
    await ctx.raw.insert(costEvents).values([
      {
        orgId: ctx.orgId,
        runId: ctx.scoutRunId ?? null,
        agentType: 'profiler',
        provider: 'apify',
        operationType: 'scrape_profile',
        costUsd: profileResult.costUsd.toFixed(6),
        latencyMs: Date.now() - apifyStart,
        success: true,
        metadata: { lead_id: ctx.lead.id, linkedin_url: ctx.lead.linkedinUrl },
      },
      {
        orgId: ctx.orgId,
        runId: ctx.scoutRunId ?? null,
        agentType: 'profiler',
        provider: 'apify',
        operationType: 'scrape_posts',
        costUsd: postsResult.costUsd.toFixed(6),
        latencyMs: Date.now() - apifyStart,
        success: true,
        metadata: { lead_id: ctx.lead.id, posts_count: postsResult.posts.length },
      },
      {
        orgId: ctx.orgId,
        runId: ctx.scoutRunId ?? null,
        agentType: 'profiler',
        provider: 'anthropic',
        operationType: 'extraction_linkedin',
        costUsd: '0.000000',
        latencyMs: 0,
        success: false,
        errorCode: extractErr instanceof Error ? extractErr.message.slice(0, 200) : 'UNKNOWN',
        metadata: { lead_id: ctx.lead.id, category },
      },
    ])
    throw extractErr
  }

  // ─── Per-hook screenshots (Vercel browser, even for LinkedIn) ────
  // Sprint 6b uses Vercel agent-browser for ALL screenshots — LinkedIn
  // hooks point to the lead's profile URL. Apify itself doesn't provide
  // screenshot capability for this use case.
  const { evidenceUrls, screenshotCostUsd } = await captureAndUploadScreenshots({
    hooks: extractResult.signals.hook_candidates,
    sourceUrl: profileResult.metadata.profileUrl,
    sourceType: 'linkedin',
    orgId: ctx.orgId,
    leadId: ctx.lead.id,
    vercel: ctx.vercel,
    storageMockMode: ctx.storageMockMode,
    logger: ctx.logger,
  })

  // ─── cost_events (3 rows: profile + posts + extraction) ──────────
  // Screenshot cost rolled into a fourth metadata field on the profile row
  // (linkedin screenshots come via Vercel browser, but accounting groups
  // them under apify scrape semantically for ROI per-source attribution).
  await ctx.raw.insert(costEvents).values([
    {
      orgId: ctx.orgId,
      runId: ctx.scoutRunId ?? null,
      agentType: 'profiler',
      provider: 'apify',
      operationType: 'scrape_profile',
      costUsd: (profileResult.costUsd + screenshotCostUsd).toFixed(6),
      latencyMs: Date.now() - apifyStart,
      success: true,
      metadata: {
        lead_id: ctx.lead.id,
        linkedin_url: ctx.lead.linkedinUrl,
        screenshots_count: evidenceUrls.length,
        screenshot_cost_usd: screenshotCostUsd,
      },
    },
    {
      orgId: ctx.orgId,
      runId: ctx.scoutRunId ?? null,
      agentType: 'profiler',
      provider: 'apify',
      operationType: 'scrape_posts',
      costUsd: postsResult.costUsd.toFixed(6),
      latencyMs: Date.now() - apifyStart,
      success: true,
      metadata: { lead_id: ctx.lead.id, posts_count: postsResult.posts.length },
    },
    {
      orgId: ctx.orgId,
      runId: ctx.scoutRunId ?? null,
      agentType: 'profiler',
      provider: 'anthropic',
      operationType: 'extraction_linkedin',
      tokensIn: extractResult.tokensIn,
      tokensOut: extractResult.tokensOut,
      costUsd: extractResult.costUsd.toFixed(6),
      latencyMs: extractResult.latencyMs,
      success: true,
      metadata: {
        lead_id: ctx.lead.id,
        model: ctx.anthropic.model,
        stage: extractResult.signals.company_stage,
        hook_count: extractResult.signals.hook_candidates.length,
      },
    },
  ])

  return {
    sourceName: 'linkedin',
    signals: extractResult.signals,
    evidenceUrls,
    totalCostUsd:
      profileResult.costUsd + postsResult.costUsd + screenshotCostUsd + extractResult.costUsd,
    phone: profileResult.profile.phone ?? null,
  }
}

async function scrapeAndExtractNews(
  ctx: ScrapeAndExtractBaseContext & { vercel: VercelBrowserClient },
): Promise<SourceExtractionResult> {
  if (!ctx.lead.companyDomain) {
    throw new TaggedAgentError(
      'NO_COMPANY_DOMAIN',
      'companyDomain missing for news source query',
      { classification: 'permanent' },
    )
  }

  // ─── Scrape Google News ──────────────────────────────────────────
  const query = `"${ctx.lead.company}" OR site:${ctx.lead.companyDomain}`
  const scrapeStart = Date.now()
  let newsResult
  try {
    newsResult = await withTransientRetry(
      () => ctx.vercel.scrapeGoogleNews(query, { daysBack: 90, maxResults: 10 }),
      'vercel_browser',
      {
        maxRetries: ctx.retryMaxAttempts ?? 3,
        backoffBaseMs: ctx.retryBackoffBaseMs,
      },
    )
  } catch (scrapeErr) {
    const category = classifyError(scrapeErr, 'vercel_browser')
    await ctx.raw.insert(costEvents).values({
      orgId: ctx.orgId,
      runId: ctx.scoutRunId ?? null,
      agentType: 'profiler',
      provider: 'vercel_browser',
      operationType: 'scrape_news',
      costUsd: '0.000000',
      latencyMs: Date.now() - scrapeStart,
      success: false,
      errorCode: scrapeErr instanceof Error ? scrapeErr.message.slice(0, 200) : 'UNKNOWN',
      metadata: { lead_id: ctx.lead.id, query, category },
    })
    throw scrapeErr
  }

  // ─── Extract ──────────────────────────────────────────────────────
  let extractResult
  try {
    extractResult = await extractNewsSignals({
      articles: newsResult.articles,
      lead: ctx.lead,
      icp: ctx.icp,
      anthropicClient: ctx.anthropic,
    })
  } catch (extractErr) {
    const category = classifyError(extractErr, 'anthropic')
    await ctx.raw.insert(costEvents).values([
      {
        orgId: ctx.orgId,
        runId: ctx.scoutRunId ?? null,
        agentType: 'profiler',
        provider: 'vercel_browser',
        operationType: 'scrape_news',
        costUsd: newsResult.costUsd.toFixed(6),
        latencyMs: Date.now() - scrapeStart,
        success: true,
        metadata: { lead_id: ctx.lead.id, query, results_count: newsResult.articles.length },
      },
      {
        orgId: ctx.orgId,
        runId: ctx.scoutRunId ?? null,
        agentType: 'profiler',
        provider: 'anthropic',
        operationType: 'extraction_news',
        costUsd: '0.000000',
        latencyMs: 0,
        success: false,
        errorCode: extractErr instanceof Error ? extractErr.message.slice(0, 200) : 'UNKNOWN',
        metadata: { lead_id: ctx.lead.id, category },
      },
    ])
    throw extractErr
  }

  // ─── Per-hook screenshots ─────────────────────────────────────────
  // News hooks reference specific articles, but for Sprint 6b mock we
  // capture at a representative URL (first article's url, or domain
  // fallback). Sprint 7+ live mode will use the per-article URL.
  const screenshotUrl =
    newsResult.articles[0]?.url ?? `https://news.google.com/search?q=${encodeURIComponent(query)}`
  const { evidenceUrls, screenshotCostUsd } = await captureAndUploadScreenshots({
    hooks: extractResult.signals.hook_candidates,
    sourceUrl: screenshotUrl,
    sourceType: 'news',
    orgId: ctx.orgId,
    leadId: ctx.lead.id,
    vercel: ctx.vercel,
    storageMockMode: ctx.storageMockMode,
    logger: ctx.logger,
  })

  // ─── cost_events (2 rows: scrape with screenshots + extraction) ──
  const scrapeCostTotal = newsResult.costUsd + screenshotCostUsd
  await ctx.raw.insert(costEvents).values([
    {
      orgId: ctx.orgId,
      runId: ctx.scoutRunId ?? null,
      agentType: 'profiler',
      provider: 'vercel_browser',
      operationType: 'scrape_news',
      costUsd: scrapeCostTotal.toFixed(6),
      latencyMs: Date.now() - scrapeStart,
      success: true,
      metadata: {
        lead_id: ctx.lead.id,
        query,
        results_count: newsResult.articles.length,
        screenshots_count: evidenceUrls.length,
        screenshot_cost_usd: screenshotCostUsd,
      },
    },
    {
      orgId: ctx.orgId,
      runId: ctx.scoutRunId ?? null,
      agentType: 'profiler',
      provider: 'anthropic',
      operationType: 'extraction_news',
      tokensIn: extractResult.tokensIn,
      tokensOut: extractResult.tokensOut,
      costUsd: extractResult.costUsd.toFixed(6),
      latencyMs: extractResult.latencyMs,
      success: true,
      metadata: {
        lead_id: ctx.lead.id,
        model: ctx.anthropic.model,
        articles_count: newsResult.articles.length,
        hook_count: extractResult.signals.hook_candidates.length,
      },
    },
  ])

  return {
    sourceName: 'news',
    signals: extractResult.signals,
    evidenceUrls,
    totalCostUsd: scrapeCostTotal + extractResult.costUsd,
  }
}

// ─── Dossier mapping (Sprint 6b — from synthesis output) ────────────

const SOURCE_NAMES: ProfilerSourceName[] = ['company_website', 'linkedin', 'news']

function buildDossierFromSynthesis(args: {
  /** Final dossier to persist — Phase 6 synthesis OR Phase 8 final synthesis. */
  synthesis: SynthesizedDossier
  successfulSources: SourceExtractionResult[]
  allEvidenceUrls: UploadedScreenshot[]
  /** Sprint 7b — deep research output (null when Phase 7 skipped/failed). */
  deepResearchOutput?: DeepResearchOutput | null
  /** Sprint 7b — phase metadata persisted into rawSignals for observability. */
  phaseMeta?: {
    phase7Triggered: boolean
    phase7Failed: boolean
    phase8Ran: boolean
    initialConfidence: number
    finalConfidence: number
  }
}): {
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
  evidenceUrls: Array<{
    hookId: string
    url: string
    capturedAt: string
    sourceType: ProfilerSourceName
  }>
  rawSignals: Record<string, unknown>
} {
  // ─── pains — derive from synthesis.painInferred (single consolidated entry)
  const pains = args.synthesis.painInferred
    ? [
        {
          description: args.synthesis.painInferred,
          sourceUrl: 'synthesis',
          sourceQuote: args.synthesis.painInferred,
          confidence: args.synthesis.confidenceScore,
          recencyDaysAgo: 0,
        },
      ]
    : []

  // ─── interests — synthesis hooks become interest topics
  const interests = args.synthesis.hookCandidates.slice(0, 5).map((hc) => ({
    topic: hc.hook,
    sourceUrl: `synthesis:${hc.sourceName}`,
    confidence: hc.confidence,
    signalStrength:
      hc.confidence > 0.85
        ? ('strong' as const)
        : hc.confidence > 0.7
          ? ('medium' as const)
          : ('weak' as const),
  }))

  // ─── recentChanges — aggregate across successful sources
  const nowIso = new Date().toISOString()
  const recentChanges: Array<{
    kind: string
    description: string
    sourceUrl: string
    occurredAt: string
  }> = []
  for (const src of args.successfulSources) {
    for (const news of src.signals.recent_news) {
      recentChanges.push({
        kind: 'news',
        description: news,
        sourceUrl: `${src.sourceName}`,
        occurredAt: nowIso,
      })
    }
    for (const hiring of src.signals.hiring_signals.slice(0, 2)) {
      recentChanges.push({
        kind: 'hiring_signal',
        description: hiring,
        sourceUrl: `${src.sourceName}`,
        occurredAt: nowIso,
      })
    }
    for (const growth of src.signals.growth_signals.slice(0, 2)) {
      recentChanges.push({
        kind: 'growth_signal',
        description: growth,
        sourceUrl: `${src.sourceName}`,
        occurredAt: nowIso,
      })
    }
  }

  // ─── Sprint 7b — aggregate deep research findings into recentChanges +
  // collect deep-research evidence URLs (sourceType='deep_research').
  const deepEvidenceUrls: Array<{
    hookId: string
    url: string
    capturedAt: string
    sourceType: ProfilerSourceName
  }> = []
  if (args.deepResearchOutput) {
    const dr = args.deepResearchOutput
    const categories: Array<[string, DeepResearchOutput['succession_signals']]> = [
      ['succession', dr.succession_signals],
      ['hiring', dr.hiring_signals],
      ['tech_stack', dr.tech_stack_signals],
      ['recent_activity', dr.recent_activity_signals],
    ]
    for (const [kind, category] of categories) {
      for (const finding of category.findings) {
        recentChanges.push({
          kind: `deep_research_${kind}`,
          description: finding.signal,
          sourceUrl: finding.source_url ?? 'deep_research',
          occurredAt: nowIso,
        })
        // Each finding with a source_url becomes an evidence entry. hookId
        // is synthesized (deep research findings aren't screenshot-keyed).
        if (finding.source_url) {
          deepEvidenceUrls.push({
            hookId: crypto.randomUUID(),
            url: finding.source_url,
            capturedAt: nowIso,
            sourceType: 'deep_research',
          })
        }
      }
    }
  }

  // ─── rawSignals — per-source breakdown + partial flag + deep research
  const successfulByName = new Map(
    args.successfulSources.map((s) => [s.sourceName, s.signals] as const),
  )
  const partialEnrichment = args.successfulSources.length < 3
  const missingSources = SOURCE_NAMES.filter((name) => !successfulByName.has(name))

  const rawSignals: Record<string, unknown> = {
    companyWebsiteSignals: successfulByName.get('company_website') ?? null,
    linkedinSignals: successfulByName.get('linkedin') ?? null,
    newsSignals: successfulByName.get('news') ?? null,
    // Sprint 7b — full deep research dossier (null when Phase 7 skipped/failed).
    deepResearchSignals: args.deepResearchOutput ?? null,
    synthesis: {
      hookCandidates: args.synthesis.hookCandidates,
      recommendedAngle: args.synthesis.recommendedAngle,
      painInferred: args.synthesis.painInferred,
      confidenceScore: args.synthesis.confidenceScore,
    },
    partialEnrichment,
    missingSources,
    // Sprint 7b — phase observability (Hermes Sprint 8 reads these to learn
    // when deep research earns its cost).
    ...(args.phaseMeta
      ? {
          phase7Triggered: args.phaseMeta.phase7Triggered,
          phase7Failed: args.phaseMeta.phase7Failed,
          phase8Ran: args.phaseMeta.phase8Ran,
          initialConfidence: args.phaseMeta.initialConfidence,
          finalConfidence: args.phaseMeta.finalConfidence,
        }
      : {}),
  }

  return {
    pains,
    interests,
    recentChanges,
    evidenceUrls: [...args.allEvidenceUrls, ...deepEvidenceUrls],
    rawSignals,
  }
}

// ─── Main processor (Sprint 6b) ─────────────────────────────────────

export async function processProfilerJob(
  job: { data: ProfilerJob },
  ctx: WorkerContext,
  overrides: ProcessProfilerJobOverrides = {},
): Promise<ProfilerResult> {
  const { leadId, orgId, scoutRunId } = job.data
  const raw = ctx.db.raw

  // ─── Phase 1: Load lead + ICP (unchanged from Sprint 6a) ──────────
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

  // ─── Phase 2: skip si !icpId (Sprint 6a graceful path) ────────────
  if (!lead.icpId) {
    ctx.logger.info({ leadId }, '[profiler] skipping — lead has no icpId')
    return {
      ok: true,
      leadId,
      status: 'skipped',
      hookCount: 0,
      costUsd: 0,
      successfulSources: [],
      failedSources: [],
      phase7Triggered: false,
      phase7Failed: false,
      phase8Ran: false,
    }
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

  // ─── Slack webhook lookup (used by failure path) ──────────────────
  const [org] = await raw
    .select({ slackWebhookUrl: orgsTable.slackWebhookUrl })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId))
  const slackWebhookUrl = org?.slackWebhookUrl ?? null

  // ─── Phase 3: leads.status='enriching' + upsert dossier seed ──────
  await raw
    .update(leadsTable)
    .set({ status: 'enriching', updatedAt: new Date() })
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))

  await raw
    .insert(leadDossiersTable)
    .values({
      leadId,
      orgId,
      enrichedBy: 'profiler_agent_v3',
      isStale: false,
    })
    .onConflictDoUpdate({
      target: leadDossiersTable.leadId,
      set: {
        enrichedBy: 'profiler_agent_v3',
        isStale: false,
        updatedAt: new Date(),
      },
    })

  // ─── Phase 4: Graceful path — no companyDomain ────────────────────
  // Manual-ingest leads without companyDomain still flow through. Mark
  // enriched with empty dossier; founder can paste a domain later and
  // re-trigger via the manual API path.
  if (!lead.companyDomain) {
    await raw
      .update(leadsTable)
      .set({
        status: 'enriched',
        enrichedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))
    ctx.logger.info({ leadId }, '[profiler] enriched empty — no companyDomain')
    return {
      ok: true,
      leadId,
      status: 'enriched',
      hookCount: 0,
      costUsd: 0,
      successfulSources: [],
      failedSources: [],
      phase7Triggered: false,
      phase7Failed: false,
      phase8Ran: false,
    }
  }

  // ─── Build per-source context (shared across helpers) ─────────────
  const vercel = overrides.vercel ?? new VercelBrowserClient()
  const apify = overrides.apify ?? new ApifyClient()
  const anthropic = overrides.anthropic ?? new AnthropicClient({ apiKey: 'mock' })
  // Sprint 9 CP2 — tier-orchestrated company-website scrape (Tier 1 HTTP-direct
  // → Tier 2 Vercel; Tier 2 wraps `vercel` so mock/live mode aligns).
  const browser = overrides.browser ?? createDefaultBrowserOrchestrator(vercel)

  // Sprint 7a — leads.{fullName, firstName, lastName, company, role}
  // are nullable post-migration 0007 (manual ingest path may create a
  // lead from URL alone, with identity fields populated by Profiler
  // enrichment afterwards). Synthesize placeholders here so LeadShape's
  // string contract stays clean and the prompt builders don't render
  // "null at null" in their headers.
  const placeholderName = lead.companyDomain ?? lead.linkedinUrl ?? lead.id
  const leadShape: LeadShape & { id: string } = {
    id: lead.id,
    fullName: lead.fullName ?? `Pending enrichment (${placeholderName})`,
    firstName: lead.firstName ?? 'Unknown',
    lastName: lead.lastName ?? 'Unknown',
    company: lead.company ?? lead.companyDomain ?? 'Unknown company',
    role: lead.role ?? 'Unknown',
    companyDomain: lead.companyDomain,
    email: lead.email,
    linkedinUrl: lead.linkedinUrl,
  }
  const icpShape: IcpShape = {
    name: icp.name,
    definitionNaturalLanguage: icp.definitionNaturalLanguage,
    parsedFilters: icp.parsedFilters,
  }

  const baseCtx: ScrapeAndExtractBaseContext = {
    lead: leadShape,
    icp: icpShape,
    orgId,
    scoutRunId: scoutRunId ?? null,
    anthropic,
    raw,
    logger: ctx.logger,
    storageMockMode: overrides.storageMockMode,
    retryBackoffBaseMs: overrides.retryBackoffBaseMs,
    retryMaxAttempts: overrides.retryMaxAttempts,
  }

  try {
    // ─── Phase 5: Run 3 sources in parallel ─────────────────────────
    const sourceResults = await Promise.allSettled<SourceExtractionResult>([
      scrapeAndExtractCompanyWebsite({ ...baseCtx, vercel, browser }),
      lead.linkedinUrl
        ? scrapeAndExtractLinkedin({ ...baseCtx, vercel, apify })
        : Promise.reject(
            new TaggedAgentError('NO_LINKEDIN_URL', 'linkedinUrl missing', {
              classification: 'permanent',
            }),
          ),
      scrapeAndExtractNews({ ...baseCtx, vercel }),
    ])

    const successful: SourceExtractionResult[] = []
    const failed: Array<{ sourceName: ProfilerSourceName; reason: unknown }> = []
    sourceResults.forEach((result, idx) => {
      const sourceName = SOURCE_NAMES[idx]!
      if (result.status === 'fulfilled') {
        successful.push(result.value)
      } else {
        failed.push({ sourceName, reason: result.reason })
        ctx.logger.warn(
          {
            leadId,
            sourceName,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          },
          '[profiler] source extraction failed (non-fatal — partial enrichment continues)',
        )
      }
    })

    // ─── Phase 5b: All sources failed — revert + Slack ──────────────
    if (successful.length === 0) {
      // Pick the first failure for the Slack notify (representative).
      const firstFail = failed[0]
      const reason = firstFail?.reason
      const message = reason instanceof Error ? reason.message : String(reason)
      const code =
        reason instanceof TaggedAgentError
          ? reason.tag
          : message.includes(':')
            ? message.split(':')[0]!.trim()
            : 'UNKNOWN'
      let category = classifyError(reason, 'profiler')
      // All-source failure is operationally a PERMANENT problem from the
      // founder's POV (no useful dossier emitted) even if root cause was
      // TRANSIENT — retries already exhausted inside each helper.
      if (category === 'transient') category = 'permanent'

      await raw
        .delete(leadDossiersTable)
        .where(
          and(eq(leadDossiersTable.leadId, leadId), eq(leadDossiersTable.orgId, orgId)),
        )
      await raw
        .update(leadsTable)
        .set({ status: 'discovered', updatedAt: new Date() })
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))

      ctx.logger.error(
        { leadId, failedCount: failed.length, code, category },
        '[profiler] all 3 sources failed — reverting to discovered',
      )

      await notifySlackIfConfigured(
        ctx,
        slackWebhookUrl,
        {
          kind: category === 'quota' ? 'quota' : 'failure',
          leadId,
          leadName: lead.fullName ?? leadShape.fullName,
          company: lead.company ?? leadShape.company,
          error: { category, message: message.slice(0, 200), code },
          provider: 'profiler',
        },
        overrides.slack,
      )

      // Throw so BullMQ logs the failure + retry policy decides whether to re-enqueue.
      throw reason instanceof Error
        ? reason
        : new Error(`ALL_SOURCES_FAILED: ${message}`)
    }

    // ─── Phase 6: Synthesis ────────────────────────────────────────
    const synthesisSources: SynthesisSourceInput[] = successful.map((s) => ({
      sourceName: s.sourceName,
      signals: s.signals,
    }))
    const missingSourceNames = failed.map((f) => f.sourceName)

    const synthesis = await synthesizeDossier({
      sources: synthesisSources,
      partialEnrichment: successful.length < 3,
      missingSources: missingSourceNames,
      lead: leadShape,
      icp: icpShape,
      anthropicClient: anthropic,
    })

    await raw.insert(costEvents).values({
      orgId,
      runId: scoutRunId ?? null,
      agentType: 'profiler',
      provider: 'anthropic',
      operationType: 'synthesis',
      tokensIn: synthesis.tokensIn,
      tokensOut: synthesis.tokensOut,
      costUsd: synthesis.costUsd.toFixed(6),
      latencyMs: synthesis.latencyMs,
      success: true,
      metadata: {
        lead_id: leadId,
        model: anthropic.model,
        sources_count: successful.length,
        missing_sources: missingSourceNames,
        hook_count: synthesis.hookCandidates.length,
      },
    })

    // ─── Phase 7: Deep research (conditional) ──────────────────────
    // Fires only when the Phase 6 synthesis confidence is below threshold.
    // High-confidence leads skip the expensive Opus research entirely.
    let deepResearchOutput: DeepResearchOutput | null = null
    let phase7Failed = false
    const phase7Triggered = synthesis.confidenceScore < DEEP_RESEARCH_THRESHOLD

    if (phase7Triggered) {
      ctx.logger.info(
        { leadId, initialConfidence: synthesis.confidenceScore, threshold: DEEP_RESEARCH_THRESHOLD },
        '[profiler] Phase 7: triggering deep research',
      )
      const deepResearchAgent =
        overrides.deepResearchAgent ??
        new DeepResearchAgent({
          anthropicClient: anthropic,
          apifyClient: apify,
          vercelBrowserClient: vercel,
        })
      try {
        deepResearchOutput = await withTransientRetry(
          () =>
            deepResearchAgent.research({
              lead: leadShape,
              icp: icpShape,
              guidance: icp.deepResearchGuidance ?? null,
              initialSynthesis: synthesis,
            }),
          'anthropic',
          {
            // Lower retry budget — Opus deep research is expensive.
            maxRetries: overrides.retryMaxAttempts ?? 2,
            backoffBaseMs: overrides.retryBackoffBaseMs,
          },
        )

        // Granular Phase 7 cost_events: LLM + web_search + web_fetch +
        // (conditional) custom tools.
        const phase7CostRows: Array<typeof costEvents.$inferInsert> = [
          {
            orgId,
            runId: scoutRunId ?? null,
            agentType: 'profiler',
            provider: 'anthropic',
            operationType: 'deep_research_llm',
            tokensIn: deepResearchOutput.tokensIn,
            tokensOut: deepResearchOutput.tokensOut,
            costUsd: deepResearchOutput.llmCostUsd.toFixed(6),
            latencyMs: deepResearchOutput.latencyMs,
            success: true,
            metadata: { lead_id: leadId, model: 'claude-opus-4-7' },
          },
          {
            orgId,
            runId: scoutRunId ?? null,
            agentType: 'profiler',
            provider: 'anthropic',
            operationType: 'deep_research_web_search',
            costUsd: (deepResearchOutput.toolCalls.webSearchCount * WEB_SEARCH_COST_USD).toFixed(6),
            success: true,
            metadata: { lead_id: leadId, count: deepResearchOutput.toolCalls.webSearchCount },
          },
          {
            orgId,
            runId: scoutRunId ?? null,
            agentType: 'profiler',
            provider: 'anthropic',
            operationType: 'deep_research_web_fetch',
            costUsd: (deepResearchOutput.toolCalls.webFetchCount * WEB_FETCH_COST_USD).toFixed(6),
            success: true,
            metadata: { lead_id: leadId, count: deepResearchOutput.toolCalls.webFetchCount },
          },
          ...deepResearchOutput.toolCalls.customToolCalls.map((call) => ({
            orgId,
            runId: scoutRunId ?? null,
            agentType: 'profiler' as const,
            provider: (call.provider === 'apify' ? 'apify' : 'vercel_browser') as
              | 'apify'
              | 'vercel_browser',
            operationType: 'deep_research_custom_tool',
            costUsd: call.costUsd.toFixed(6),
            success: true,
            metadata: { lead_id: leadId, tool_name: call.name },
          })),
        ]
        await raw.insert(costEvents).values(phase7CostRows)
      } catch (deepErr) {
        // Isolated failure — fall back to Phase 6 synthesis as the final
        // dossier. Record a failure cost_event so the spend (if any) +
        // failure category are visible.
        phase7Failed = true
        deepResearchOutput = null
        const category = classifyError(deepErr, 'anthropic')
        await raw.insert(costEvents).values({
          orgId,
          runId: scoutRunId ?? null,
          agentType: 'profiler',
          provider: 'anthropic',
          operationType: 'deep_research_llm',
          costUsd: '0.000000',
          success: false,
          errorCode: deepErr instanceof Error ? deepErr.message.slice(0, 200) : 'UNKNOWN',
          metadata: { lead_id: leadId, category },
        })
        ctx.logger.warn(
          { leadId, error: deepErr instanceof Error ? deepErr.message : String(deepErr) },
          '[profiler] Phase 7 deep research failed — falling back to Phase 6 synthesis',
        )
      }
    }

    // ─── Phase 8: Final synthesis (conditional) ────────────────────
    // Runs only when Phase 7 produced output. Consolidates 4 sources;
    // confidence ceiling 0.95. When skipped, the Phase 6 synthesis IS
    // the final dossier.
    let synthesisFinal: SynthesizedDossier = synthesis
    if (deepResearchOutput) {
      synthesisFinal = await synthesizeFinalDossier({
        sources: synthesisSources,
        deepResearchOutput,
        initialSynthesis: synthesis,
        lead: leadShape,
        icp: icpShape,
        anthropicClient: anthropic,
      })
      await raw.insert(costEvents).values({
        orgId,
        runId: scoutRunId ?? null,
        agentType: 'profiler',
        provider: 'anthropic',
        operationType: 'synthesis_final',
        tokensIn: synthesisFinal.tokensIn,
        tokensOut: synthesisFinal.tokensOut,
        costUsd: synthesisFinal.costUsd.toFixed(6),
        latencyMs: synthesisFinal.latencyMs,
        success: true,
        metadata: {
          lead_id: leadId,
          model: anthropic.model,
          initial_confidence: synthesis.confidenceScore,
          final_confidence: synthesisFinal.confidenceScore,
          hook_count: synthesisFinal.hookCandidates.length,
        },
      })
    }

    // ─── Phase 9: Persist dossier (uses synthesisFinal) ────────────
    const allEvidenceUrls = successful.flatMap((s) => s.evidenceUrls)
    const dossierFields = buildDossierFromSynthesis({
      synthesis: synthesisFinal,
      successfulSources: successful,
      allEvidenceUrls,
      deepResearchOutput,
      phaseMeta: {
        phase7Triggered,
        phase7Failed,
        phase8Ran: deepResearchOutput !== null,
        initialConfidence: synthesis.confidenceScore,
        finalConfidence: synthesisFinal.confidenceScore,
      },
    })

    await raw
      .update(leadDossiersTable)
      .set({
        pains: dossierFields.pains,
        interests: dossierFields.interests,
        recentChanges: dossierFields.recentChanges,
        evidenceUrls: dossierFields.evidenceUrls,
        rawSignals: dossierFields.rawSignals,
        confidenceScore: synthesisFinal.confidenceScore,
        isStale: false,
        enrichedBy: 'profiler_agent_v3',
        updatedAt: new Date(),
      })
      .where(
        and(eq(leadDossiersTable.leadId, leadId), eq(leadDossiersTable.orgId, orgId)),
      )

    // ─── Phase 10: Mark lead as enriched (+ write extracted phone) ──
    // Collect a phone across sources — LinkedIn contact preferred (personal),
    // then the company website line. Normalize to E.164; only write when we
    // found a valid one (never overwrite an existing phone with null).
    const rawPhone =
      successful.find((s) => s.sourceName === 'linkedin')?.phone ??
      successful.find((s) => s.sourceName === 'company_website')?.phone ??
      null
    const extractedPhone = normalizePhone(rawPhone)
    if (extractedPhone) {
      ctx.logger.info({ leadId, source: 'profiler' }, '[profiler] phone extracted')
    }

    await raw
      .update(leadsTable)
      .set({
        status: 'enriched',
        enrichedAt: new Date(),
        updatedAt: new Date(),
        ...(extractedPhone ? { phone: extractedPhone } : {}),
      })
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))

    const deepResearchCostUsd = deepResearchOutput
      ? deepResearchOutput.llmCostUsd +
        deepResearchOutput.toolCalls.webSearchCount * WEB_SEARCH_COST_USD +
        deepResearchOutput.toolCalls.webFetchCount * WEB_FETCH_COST_USD +
        deepResearchOutput.toolCalls.customToolCalls.reduce((s, t) => s + t.costUsd, 0) +
        synthesisFinal.costUsd
      : 0
    const totalCostUsd =
      successful.reduce((sum, s) => sum + s.totalCostUsd, 0) +
      synthesis.costUsd +
      deepResearchCostUsd

    ctx.logger.info(
      {
        leadId,
        company: lead.company,
        successfulSources: successful.map((s) => s.sourceName),
        failedSources: missingSourceNames,
        hookCount: synthesisFinal.hookCandidates.length,
        initialConfidence: synthesis.confidenceScore,
        finalConfidence: synthesisFinal.confidenceScore,
        phase7Triggered,
        phase7Failed,
        phase8Ran: deepResearchOutput !== null,
        costUsd: totalCostUsd,
      },
      '[profiler] lead enriched (Sprint 7b)',
    )

    return {
      ok: true,
      leadId,
      status: 'enriched',
      hookCount: synthesisFinal.hookCandidates.length,
      costUsd: totalCostUsd,
      successfulSources: successful.map((s) => s.sourceName),
      failedSources: missingSourceNames,
      phase7Triggered,
      phase7Failed,
      phase8Ran: deepResearchOutput !== null,
    }
  } catch (err) {
    // Outer catch — covers Phase 5b throw (all-sources failure already
    // handled inside) plus any unexpected error in synthesis or dossier
    // persistence. For synthesis-time failures we still revert leads
    // and remove the dossier so the next attempt starts clean.
    const message = err instanceof Error ? err.message : String(err)
    const code =
      err instanceof TaggedAgentError
        ? err.tag
        : message.includes(':')
          ? message.split(':')[0]!.trim()
          : 'UNKNOWN'

    // Only revert + delete if we haven't already — Phase 5b cleanup
    // already happened. Use a defensive double-delete (idempotent).
    await raw
      .delete(leadDossiersTable)
      .where(
        and(eq(leadDossiersTable.leadId, leadId), eq(leadDossiersTable.orgId, orgId)),
      )
    await raw
      .update(leadsTable)
      .set({ status: 'discovered', updatedAt: new Date() })
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))

    ctx.logger.error({ leadId, code, error: message }, '[profiler] enrichment failed')
    throw err
  }
}

export const profilerWorker = defineWorker<ProfilerJob, ProfilerResult>({
  queueName: 'profiler',
  jobSchema: ProfilerJobSchema,
  concurrency: 4,
  idempotencyKey: (job) => `profiler-${job.leadId}`,
  process: (job, ctx) => processProfilerJob(job, ctx),
})
