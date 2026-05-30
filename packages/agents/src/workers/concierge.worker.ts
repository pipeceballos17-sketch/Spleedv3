import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  costEvents,
  leadDossiers as leadDossiersTable,
  leads as leadsTable,
  type DbClient,
} from '@spleed/db'
import { AnthropicClient } from '@spleed/integrations/anthropic'
import {
  SlackClient,
  buildDossierCard,
  getSlackOAuthTokens,
  type BuildDossierCardInput,
  type DossierCardDeepResearch,
} from '@spleed/integrations/slack'
import { parseConciergeQuery } from '../agents/concierge'
import { ingestLead } from '../ingest'
import type { WorkerContext } from './context'
import { defineWorker } from './define'
import { waitForJob } from './wait-for-job'

/**
 * Sprint 7c concierge worker. Founder DMs the Slack bot a lead ("who is Sarah
 * Chen from PulseAnalytics"); the event handler (apps/api POST
 * /api/slack/events) enqueues a job here. Flow:
 *
 *   1. Load the org's Slack bot token (Vault, mock-default).
 *   2. Threaded ack ("🔍 Working on dossier…").
 *   3. parseConciergeQuery → IngestPayload (Haiku, mock-default).
 *   4. parse fail → threaded clarification reply, done.
 *   5. ingestLead (shared with the HTTP handler) → lead + Profiler enqueue.
 *   6. waitForJob on the Profiler job (≤90s); timeout/fail → threaded reply.
 *   7. Build the Block Kit dossier card from the persisted dossier.
 *   8. Post the card as a threaded reply.
 *
 * External services (Slack, Anthropic, Profiler) are all mock-default, so a
 * full run is exercisable without live credentials. cost_events: one
 * concierge_parse row per run (Profiler writes its own 8-12 rows downstream).
 */
const ConciergeJobSchema = z.object({
  orgId: z.string().uuid(),
  /** DM channel id (D…) — where we post ack + dossier. */
  slackChannelId: z.string().min(1),
  /** Founder's Slack user id — surfaced in logs, used for self-message guard upstream. */
  slackUserId: z.string().min(1),
  /** The founder message ts — thread root for every reply. */
  slackThreadTs: z.string().min(1),
  /** Raw founder text to parse. */
  text: z.string().min(1),
})

export type ConciergeJob = z.infer<typeof ConciergeJobSchema>

export interface ConciergeResult {
  ok: true
  status:
    | 'posted'
    | 'parse_failed'
    | 'profiler_timeout'
    | 'profiler_failed'
    | 'no_tokens'
    | 'parked_no_icp'
    | 'no_dossier'
  leadId?: string
  parseSucceeded: boolean
  parseCostUsd: number
}

export interface ProcessConciergeJobOverrides {
  slack?: SlackClient
  anthropic?: AnthropicClient
  /** Inject to avoid a real Profiler enqueue (tests/demo). Default: real ingestLead. */
  ingest?: typeof ingestLead
  /** Inject to avoid a real Redis poll (tests/demo). Default: real waitForJob. */
  waitForJob?: typeof waitForJob
  /** Inject canned card input to avoid a real dossier read (tests/demo). */
  loadCardInput?: (args: {
    raw: DbClient
    orgId: string
    leadId: string
  }) => Promise<BuildDossierCardInput | null>
  /** Override the Profiler sync-wait ceiling (default 90s). */
  profilerTimeoutMs?: number
}

const DEFAULT_PROFILER_WAIT_MS = 90_000

/**
 * Default card loader — read the lead + its dossier and map the persisted
 * synthesis (rawSignals.synthesis) + deep research (rawSignals.deepResearchSignals)
 * onto buildDossierCard's leaf shapes. Returns null when no dossier row exists.
 */
async function loadCardInputFromDb(args: {
  raw: DbClient
  orgId: string
  leadId: string
}): Promise<BuildDossierCardInput | null> {
  const { raw, orgId, leadId } = args
  const [lead] = await raw
    .select({
      fullName: leadsTable.fullName,
      role: leadsTable.role,
      company: leadsTable.company,
      companyDomain: leadsTable.companyDomain,
      email: leadsTable.email,
      linkedinUrl: leadsTable.linkedinUrl,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))

  const [dossier] = await raw
    .select({
      rawSignals: leadDossiersTable.rawSignals,
      confidenceScore: leadDossiersTable.confidenceScore,
    })
    .from(leadDossiersTable)
    .where(and(eq(leadDossiersTable.leadId, leadId), eq(leadDossiersTable.orgId, orgId)))

  if (!lead || !dossier) return null

  const rawSignals = (dossier.rawSignals as Record<string, unknown>) ?? {}
  const synthesis =
    (rawSignals.synthesis as {
      hookCandidates?: Array<{ hook: string; confidence: number }>
      recommendedAngle?: string
      confidenceScore?: number
    }) ?? {}
  // DeepResearchOutput is structurally compatible with DossierCardDeepResearch
  // (both expose the four core-4 categories with findings[].signal).
  const deepResearch = (rawSignals.deepResearchSignals as DossierCardDeepResearch | null) ?? null

  return {
    lead: {
      fullName: lead.fullName,
      role: lead.role,
      company: lead.company,
      companyDomain: lead.companyDomain,
      email: lead.email,
      linkedinUrl: lead.linkedinUrl,
    },
    recommendedAngle: synthesis.recommendedAngle ?? 'No outreach angle surfaced.',
    confidenceScore: dossier.confidenceScore ?? synthesis.confidenceScore ?? 0,
    topHooks: (synthesis.hookCandidates ?? [])
      .slice(0, 3)
      .map((h) => ({ hook: h.hook, confidence: h.confidence })),
    deepResearch,
  }
}

export async function processConciergeJob(
  job: { data: ConciergeJob },
  ctx: WorkerContext,
  overrides: ProcessConciergeJobOverrides = {},
): Promise<ConciergeResult> {
  const { orgId, slackChannelId, slackThreadTs, text } = job.data
  const raw = ctx.db.raw

  // ─── 1. Slack bot token → client ───────────────────────────────────
  // An injected client (tests/demo) skips the Vault lookup entirely. Resolve
  // to a const so the `reply` closure below sees a non-nullable SlackClient.
  let resolvedSlack = overrides.slack
  if (!resolvedSlack) {
    const tokens = await getSlackOAuthTokens(orgId)
    if (!tokens) {
      // No installation tokens — we can't even reply. Log + give up (the
      // event handler already 200'd Slack; nothing to retry usefully).
      ctx.logger.warn({ orgId }, '[concierge] no Slack tokens for org — cannot reply')
      return { ok: true, status: 'no_tokens', parseSucceeded: false, parseCostUsd: 0 }
    }
    resolvedSlack = new SlackClient({ token: tokens.bot_token })
  }
  const slack = resolvedSlack
  const reply = (text: string, blocks?: Parameters<SlackClient['postMessage']>[0]['blocks']) =>
    slack.postMessage({ channel: slackChannelId, text, blocks, thread_ts: slackThreadTs })

  // ─── 2. Threaded ack ───────────────────────────────────────────────
  await reply('🔍 Working on dossier…')

  // ─── 3. Parse ──────────────────────────────────────────────────────
  const anthropic = overrides.anthropic ?? new AnthropicClient({ apiKey: 'mock' })
  const parsed = await parseConciergeQuery({ text, anthropicClient: anthropic })

  await raw.insert(costEvents).values({
    orgId,
    runId: null,
    agentType: 'concierge',
    provider: 'anthropic',
    operationType: 'concierge_parse',
    tokensIn: parsed.tokensIn,
    tokensOut: parsed.tokensOut,
    costUsd: parsed.costUsd.toFixed(6),
    latencyMs: parsed.latencyMs,
    success: true,
    metadata: { parse_succeeded: parsed.parseSucceeded, query_len: text.length },
  })

  // ─── 4. Parse failed ───────────────────────────────────────────────
  if (!parsed.parseSucceeded) {
    await reply(
      `I couldn't pull a lead from that${parsed.errorReason ? ` (${parsed.errorReason})` : ''}. ` +
        'Try something like: *who is Sarah Chen from PulseAnalytics*',
    )
    return { ok: true, status: 'parse_failed', parseSucceeded: false, parseCostUsd: parsed.costUsd }
  }

  // ─── 5. Ingest (shared with the HTTP handler) ──────────────────────
  const doIngest = overrides.ingest ?? ingestLead
  const ingest = await doIngest({
    orgId,
    linkedinUrl: parsed.payload.linkedinUrl,
    companyDomain: parsed.payload.companyDomain,
    name: parsed.payload.name,
    title: parsed.payload.title,
    notes: parsed.payload.notes,
    ingestSource: 'slack_concierge',
  })

  if (ingest.outcome === 'invalid_payload' || ingest.outcome === 'icp_not_in_org') {
    // invalid_payload shouldn't happen post-parse; icp_not_in_org can't (we
    // never pass an icpId). Defensive — reply + bail.
    await reply(
      "I parsed a name but couldn't create the lead. Mind rephrasing? e.g. *who is Sarah Chen from PulseAnalytics*",
    )
    return { ok: true, status: 'parse_failed', parseSucceeded: true, parseCostUsd: parsed.costUsd }
  }

  const leadId = ingest.leadId

  // Parked: new lead but the org has no default ICP, so Profiler never ran.
  if (ingest.outcome === 'inserted' && !ingest.profilerEnqueued) {
    await reply(
      `Added *${parsed.payload.name ?? leadId}* — but there's no default ICP configured, ` +
        'so I can\'t enrich it yet. Set a default ICP and re-send.',
    )
    return { ok: true, status: 'parked_no_icp', leadId, parseSucceeded: true, parseCostUsd: parsed.costUsd }
  }

  // ─── 6. Wait for Profiler (only when we enqueued one) ──────────────
  if (ingest.profilerEnqueued && ingest.profilerJobId) {
    const doWait = overrides.waitForJob ?? waitForJob
    const waitResult = await doWait({
      queueName: 'profiler',
      jobId: ingest.profilerJobId,
      timeoutMs: overrides.profilerTimeoutMs ?? DEFAULT_PROFILER_WAIT_MS,
    })
    if (waitResult.status === 'timeout') {
      await reply("Still digging — I'll follow up here when the dossier is ready.")
      return { ok: true, status: 'profiler_timeout', leadId, parseSucceeded: true, parseCostUsd: parsed.costUsd }
    }
    if (waitResult.status === 'failed') {
      await reply(
        `Enrichment failed for *${parsed.payload.name ?? leadId}*${waitResult.error ? ` (${waitResult.error})` : ''}. ` +
          'Try again in a bit.',
      )
      return { ok: true, status: 'profiler_failed', leadId, parseSucceeded: true, parseCostUsd: parsed.costUsd }
    }
  }
  // Cached existing lead (profiler not enqueued) → dossier already on file.

  // ─── 7. Build the dossier card ─────────────────────────────────────
  const loadCard = overrides.loadCardInput ?? loadCardInputFromDb
  const cardInput = await loadCard({ raw, orgId, leadId })
  if (!cardInput) {
    await reply("I added the lead but couldn't assemble a dossier yet. Try again shortly.")
    return { ok: true, status: 'no_dossier', leadId, parseSucceeded: true, parseCostUsd: parsed.costUsd }
  }

  // ─── 8. Post the card (threaded) ───────────────────────────────────
  const blocks = buildDossierCard(cardInput)
  await reply(`${cardInput.lead.fullName ?? 'Lead'} — dossier`, blocks)

  ctx.logger.info(
    { orgId, leadId, hookCount: cardInput.topHooks.length },
    '[concierge] dossier card posted',
  )
  return { ok: true, status: 'posted', leadId, parseSucceeded: true, parseCostUsd: parsed.costUsd }
}

export const conciergeWorker = defineWorker<ConciergeJob, ConciergeResult>({
  queueName: 'concierge',
  jobSchema: ConciergeJobSchema,
  concurrency: 4,
  // Dedupe Slack's at-least-once event delivery: same DM message ts → one job.
  idempotencyKey: (job) => `concierge-${job.orgId}-${job.slackThreadTs}`,
  process: (job, ctx) => processConciergeJob(job, ctx),
})

export { ConciergeJobSchema }
