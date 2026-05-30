import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  costEvents,
  icps as icpsTable,
  leadDossiers as leadDossiersTable,
  leads as leadsTable,
  outreachDrafts as outreachDraftsTable,
  outreachUnsubscribes as outreachUnsubscribesTable,
  type DbClient,
} from '@spleed/db'
import { AnthropicClient } from '@spleed/integrations/anthropic'
import { SlackClient, buildApprovalCard, getSlackOAuthTokens } from '@spleed/integrations/slack'
import { ComposerAgent, ComposerNoContactError, type ComposerInput } from '../agents/composer'
import type { WorkerContext } from './context'
import { defineWorker } from './define'

/**
 * Sprint 8.2 Composer worker — wraps the Sprint 8.1 ComposerAgent in BullMQ.
 * Triggered by the 🔄 Regenerate button (interaction handler) or a manual
 * dashboard/API call. Flow:
 *
 *   1. Load lead + ICP + dossier (DB).
 *   2. Compliance pre-check: skip if the lead is on the unsubscribe list.
 *   3. ComposerAgent.compose() — 4 steps (hook → angle → draft → quality).
 *   4. Insert outreach_drafts (pending_approval | failed) + 4 cost_events.
 *   5. (regenerate) mark the superseded draft 'regenerated'.
 *   6. Post the Block Kit approval card as a threaded Slack reply (when a
 *      Slack thread context is supplied) and stamp approval_slack_ts.
 *
 * External services (Anthropic, Slack) are mock-default. Injectable seams
 * (composerAgent / slack / loadContext) keep tests + demos offline.
 */
const ComposerJobSchema = z.object({
  orgId: z.string().uuid(),
  leadId: z.string().uuid(),
  /** 'regenerate' supersedes an existing draft (marks it 'regenerated'). Defaults to 'initial' at runtime. */
  mode: z.enum(['initial', 'regenerate']).optional(),
  supersedesDraftId: z.string().uuid().optional(),
  /** Slack thread context — present when triggered from a Slack thread. */
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
})

export type ComposerJob = z.infer<typeof ComposerJobSchema>

export interface ComposerResult {
  ok: true
  status:
    | 'drafted'
    | 'failed_quality'
    | 'unsubscribed_skipped'
    | 'no_contact'
    | 'no_lead'
    | 'no_dossier'
  draftId?: string
  costUsd: number
}

/** DB-loaded context for one compose run. */
export interface ComposerContext {
  input: ComposerInput
  icpId: string
  channel: 'email' | 'imessage'
  leadName: string
  /** Channel-native identifier for the unsubscribe check (email address). */
  leadEmail: string | null
}

export interface ProcessComposerJobOverrides {
  anthropic?: AnthropicClient
  composerAgent?: ComposerAgent
  slack?: SlackClient
  /** Inject to avoid the DB read of lead+icp+dossier (tests/demo). */
  loadContext?: (args: {
    raw: DbClient
    orgId: string
    leadId: string
    anthropic: AnthropicClient
  }) => Promise<ComposerContext | null>
}

interface SynthesisShape {
  hookCandidates?: Array<{ hook: string; evidence?: string; sourceName?: string; confidence: number }>
  recommendedAngle?: string
  painInferred?: string
  confidenceScore?: number
}
interface DeepResearchShape {
  recommended_hooks?: Array<{ hook: string; evidence?: string; confidence: number }>
}

/**
 * Default context loader — project the leads/icps/lead_dossiers rows onto a
 * ComposerInput. Returns null when the lead/ICP/dossier is missing (the
 * Composer needs an enriched dossier to draft from).
 */
async function loadComposerContextFromDb(args: {
  raw: DbClient
  orgId: string
  leadId: string
  anthropic: AnthropicClient
}): Promise<ComposerContext | null> {
  const { raw, orgId, leadId, anthropic } = args

  const [lead] = await raw
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, orgId)))
  if (!lead || !lead.icpId) return null

  const [icp] = await raw
    .select()
    .from(icpsTable)
    .where(and(eq(icpsTable.id, lead.icpId), eq(icpsTable.orgId, orgId)))
  if (!icp) return null

  const [dossier] = await raw
    .select({
      rawSignals: leadDossiersTable.rawSignals,
      confidenceScore: leadDossiersTable.confidenceScore,
    })
    .from(leadDossiersTable)
    .where(and(eq(leadDossiersTable.leadId, leadId), eq(leadDossiersTable.orgId, orgId)))
  if (!dossier) return null

  // Composer supports email|imessage; other channels (linkedin/x) fall back to
  // email for Sprint 8 drafting.
  const channel: 'email' | 'imessage' = icp.preferredChannel === 'imessage' ? 'imessage' : 'email'

  const rawSignals = (dossier.rawSignals as Record<string, unknown>) ?? {}
  const synthesis = (rawSignals.synthesis as SynthesisShape) ?? {}
  const deepResearch = (rawSignals.deepResearchSignals as DeepResearchShape | null) ?? null

  const hookCandidates = (synthesis.hookCandidates ?? []).map((h) => ({
    hook: h.hook,
    evidence: h.evidence ?? '',
    sourceName: (h.sourceName as ComposerInput['dossier']['hookCandidates'][number]['sourceName']) ?? 'company_website',
    confidence: h.confidence,
  }))
  const deepResearchHooks = (deepResearch?.recommended_hooks ?? []).map((h) => ({
    hook: h.hook,
    evidence: h.evidence ?? '',
    sourceName: 'deep_research' as const,
    confidence: h.confidence,
  }))

  const input: ComposerInput = {
    lead: {
      fullName: lead.fullName ?? '(pending enrichment)',
      company: lead.company ?? lead.companyDomain ?? 'Unknown company',
      role: lead.role ?? 'Unknown',
      companyDomain: lead.companyDomain,
      email: lead.email,
      // phone unsourced in Sprint 8 (no leads.phone column / extraction yet).
      phone: null,
      linkedinUrl: lead.linkedinUrl,
    },
    icp: {
      name: icp.name,
      definitionNaturalLanguage: icp.definitionNaturalLanguage,
      industry: icp.parsedFilters?.industries?.[0] ?? null,
      preferredChannel: channel,
      voiceGuidance: icp.outreachVoiceGuidance,
      footerTemplate: icp.outreachFooterTemplate,
    },
    dossier: {
      recommendedAngle: synthesis.recommendedAngle ?? 'No outreach angle surfaced.',
      painInferred: synthesis.painInferred ?? null,
      confidenceScore: dossier.confidenceScore ?? synthesis.confidenceScore ?? 0,
      hookCandidates,
      deepResearchHooks,
    },
    anthropicClient: anthropic,
  }

  return {
    input,
    icpId: icp.id,
    channel,
    leadName: lead.fullName ?? lead.company ?? leadId,
    leadEmail: lead.email,
  }
}

export async function processComposerJob(
  job: { data: ComposerJob },
  ctx: WorkerContext,
  overrides: ProcessComposerJobOverrides = {},
): Promise<ComposerResult> {
  const { orgId, leadId, supersedesDraftId, slackChannelId, slackThreadTs } = job.data
  const mode = job.data.mode ?? 'initial'
  const raw = ctx.db.raw

  const anthropic = overrides.anthropic ?? new AnthropicClient({ apiKey: 'mock' })
  const composerAgent = overrides.composerAgent ?? new ComposerAgent({ anthropicClient: anthropic })

  // ─── 1. Load context ───────────────────────────────────────────────
  const loadContext = overrides.loadContext ?? loadComposerContextFromDb
  const composerCtx = await loadContext({ raw, orgId, leadId, anthropic })
  if (!composerCtx) {
    ctx.logger.warn({ orgId, leadId }, '[composer] no lead/icp/dossier — cannot draft')
    return { ok: true, status: 'no_dossier', costUsd: 0 }
  }
  const { input, icpId, leadName, leadEmail } = composerCtx

  // ─── 2. Compliance pre-check — unsubscribe suppression ─────────────
  // Email is the lead-native identifier in Sprint 8 (no phone column yet).
  // The Outreach Operator re-checks at send for the race window.
  if (leadEmail) {
    const [suppressed] = await raw
      .select({ id: outreachUnsubscribesTable.id })
      .from(outreachUnsubscribesTable)
      .where(
        and(
          eq(outreachUnsubscribesTable.orgId, orgId),
          eq(outreachUnsubscribesTable.channel, 'email'),
          eq(outreachUnsubscribesTable.identifier, leadEmail),
        ),
      )
    if (suppressed) {
      ctx.logger.info({ orgId, leadId, leadEmail }, '[composer] lead unsubscribed — skipping draft')
      return { ok: true, status: 'unsubscribed_skipped', costUsd: 0 }
    }
  }

  // ─── 3. Compose (Phase 0 channel reco + 4-step pipeline) ───────────
  let output
  try {
    output = await composerAgent.compose(input)
  } catch (err) {
    if (err instanceof ComposerNoContactError) {
      ctx.logger.warn({ orgId, leadId }, '[composer] manual contact lookup required — no draft')
      if (slackChannelId && slackThreadTs) {
        const slack = await resolveSlackClient(overrides, orgId, ctx)
        if (slack) {
          await slack.postMessage({
            channel: slackChannelId,
            thread_ts: slackThreadTs,
            text: `📇 *${leadName}* is missing contact data — manual lookup required before outreach. (${err.reasoning})`,
          })
        }
      }
      return { ok: true, status: 'no_contact', costUsd: 0 }
    }
    throw err
  }
  const cb = output.costBreakdown
  // Phase 0 may override the ICP default — the draft + cost_events use the
  // recommended channel.
  const channel = output.channel

  // ─── 4. cost_events — one row per step (5: channel reco + 4 pipeline) ─
  await raw.insert(costEvents).values([
    {
      orgId, runId: null, agentType: 'composer', provider: 'anthropic',
      operationType: 'composer_channel_recommendation',
      tokensIn: cb.channelRecommendation.tokensIn, tokensOut: cb.channelRecommendation.tokensOut,
      costUsd: cb.channelRecommendation.costUsd.toFixed(6), latencyMs: cb.channelRecommendation.latencyMs,
      success: true, metadata: { lead_id: leadId, channel, confidence: output.channelConfidence },
    },
    {
      orgId, runId: null, agentType: 'composer', provider: 'anthropic',
      operationType: 'composer_hook_selection',
      tokensIn: cb.hookSelection.tokensIn, tokensOut: cb.hookSelection.tokensOut,
      costUsd: cb.hookSelection.costUsd.toFixed(6), latencyMs: cb.hookSelection.latencyMs,
      success: true, metadata: { lead_id: leadId, model: anthropic.model },
    },
    {
      orgId, runId: null, agentType: 'composer', provider: 'anthropic',
      operationType: 'composer_angle_generation',
      tokensIn: cb.angleGeneration.tokensIn, tokensOut: cb.angleGeneration.tokensOut,
      costUsd: cb.angleGeneration.costUsd.toFixed(6), latencyMs: cb.angleGeneration.latencyMs,
      success: true, metadata: { lead_id: leadId, model: anthropic.model },
    },
    {
      orgId, runId: null, agentType: 'composer', provider: 'anthropic',
      operationType: 'composer_draft_composition',
      tokensIn: cb.draftComposition.tokensIn, tokensOut: cb.draftComposition.tokensOut,
      costUsd: cb.draftComposition.costUsd.toFixed(6), latencyMs: cb.draftComposition.latencyMs,
      success: true, metadata: { lead_id: leadId, channel },
    },
    {
      orgId, runId: null, agentType: 'composer', provider: 'anthropic',
      operationType: 'composer_quality_check',
      tokensIn: cb.qualityCheck.tokensIn, tokensOut: cb.qualityCheck.tokensOut,
      costUsd: cb.qualityCheck.costUsd.toFixed(6), latencyMs: cb.qualityCheck.latencyMs,
      success: true, metadata: { lead_id: leadId, passed: output.qualityVerdict.passed },
    },
  ])

  // ─── 5. Persist the draft ──────────────────────────────────────────
  const composerMetadata: Record<string, unknown> = {
    mode,
    voiceApplied: input.icp.voiceGuidance ?? null,
    channelReasoning: output.channelReasoning,
    channelConfidence: output.channelConfidence,
    contactData: output.contactData,
    qualityVerdict: output.qualityVerdict,
    costBreakdown: cb,
    // Persist the Slack thread context so the Outreach Operator + reply
    // webhook can post threaded follow-ups (sent confirmation, reply alerts)
    // under the same thread as the approval card.
    ...(slackChannelId ? { slackChannelId } : {}),
    ...(slackThreadTs ? { slackThreadTs } : {}),
    ...(output.status === 'composed'
      ? { selectedHooks: output.selectedHooks, angle: output.angle }
      : {}),
  }

  const [draftRow] = await raw
    .insert(outreachDraftsTable)
    .values({
      orgId,
      leadId,
      icpId,
      channel,
      subject: output.subject,
      body: output.body,
      status: output.status === 'composed' ? 'pending_approval' : 'failed',
      composerMetadata,
      enrichedBy: 'composer_agent_v1',
    })
    .returning({ id: outreachDraftsTable.id })
  const draftId = draftRow!.id

  // ─── 5b. Regenerate — supersede the prior draft ────────────────────
  if (mode === 'regenerate' && supersedesDraftId) {
    await raw
      .update(outreachDraftsTable)
      .set({ status: 'regenerated', updatedAt: new Date() })
      .where(and(eq(outreachDraftsTable.id, supersedesDraftId), eq(outreachDraftsTable.orgId, orgId)))
  }

  // ─── 6. Quality-failed → log + (optional) Slack note, no approval card
  if (output.status === 'failed_quality') {
    ctx.logger.warn(
      { orgId, leadId, draftId, issues: output.qualityVerdict.issues },
      '[composer] draft failed quality check',
    )
    if (slackChannelId && slackThreadTs) {
      const slack = await resolveSlackClient(overrides, orgId, ctx)
      if (slack) {
        await slack.postMessage({
          channel: slackChannelId,
          thread_ts: slackThreadTs,
          text: `⚠️ Draft for *${leadName}* failed the quality check (${output.qualityVerdict.issues.join('; ') || 'unknown'}). Tap 🔄 Regenerate to retry.`,
        })
      }
    }
    return { ok: true, status: 'failed_quality', draftId, costUsd: cb.totalCostUsd }
  }

  // ─── 7. Post the approval card (when a Slack thread is supplied) ────
  if (slackChannelId && slackThreadTs) {
    const slack = await resolveSlackClient(overrides, orgId, ctx)
    if (slack) {
      const blocks = buildApprovalCard({
        draftId,
        leadName,
        channel,
        subject: output.subject,
        body: output.body,
        voiceSummary: input.icp.voiceGuidance ? input.icp.voiceGuidance.slice(0, 60) : null,
        costUsd: cb.totalCostUsd,
        channelReasoning: output.channelReasoning,
        channelConfidence: output.channelConfidence,
        contact: output.contactData,
      })
      const ack = await slack.postMessage({
        channel: slackChannelId,
        thread_ts: slackThreadTs,
        text: `📝 Draft ready for ${leadName}`,
        blocks,
      })
      await raw
        .update(outreachDraftsTable)
        .set({ approvalSlackTs: ack.ts, updatedAt: new Date() })
        .where(and(eq(outreachDraftsTable.id, draftId), eq(outreachDraftsTable.orgId, orgId)))
    }
  }

  ctx.logger.info(
    { orgId, leadId, draftId, channel, costUsd: cb.totalCostUsd },
    '[composer] draft created (pending_approval)',
  )
  return { ok: true, status: 'drafted', draftId, costUsd: cb.totalCostUsd }
}

/** Resolve a Slack client from overrides or the org's Vault tokens (null if none). */
async function resolveSlackClient(
  overrides: ProcessComposerJobOverrides,
  orgId: string,
  ctx: WorkerContext,
): Promise<SlackClient | null> {
  if (overrides.slack) return overrides.slack
  const tokens = await getSlackOAuthTokens(orgId)
  if (!tokens) {
    ctx.logger.warn({ orgId }, '[composer] no Slack tokens — skipping approval card post')
    return null
  }
  return new SlackClient({ token: tokens.bot_token })
}

export const composerWorker = defineWorker<ComposerJob, ComposerResult>({
  queueName: 'composer',
  jobSchema: ComposerJobSchema,
  concurrency: 4,
  // One draft per (lead, mode) enqueue. Regenerate carries a fresh
  // supersedesDraftId so it is a distinct job from the initial compose.
  idempotencyKey: (job) =>
    job.mode === 'regenerate' && job.supersedesDraftId
      ? `composer-regen-${job.supersedesDraftId}`
      : `composer-${job.orgId}-${job.leadId}`,
  process: (job, ctx) => processComposerJob(job, ctx),
})

export { ComposerJobSchema }
