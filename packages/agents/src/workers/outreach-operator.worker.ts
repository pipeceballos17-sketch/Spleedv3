import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  costEvents,
  leads as leadsTable,
  outreachDrafts as outreachDraftsTable,
  outreachUnsubscribes as outreachUnsubscribesTable,
  type DbClient,
} from '@spleed/db'
import { SlackClient, getSlackOAuthTokens } from '@spleed/integrations/slack'
import type { WorkerContext } from './context'
import { defineWorker } from './define'

/**
 * Sprint 8.2 Outreach Operator worker (skeleton). Enqueued when a founder
 * approves a draft (Slack ✅ Approve & Send). Flow:
 *
 *   1. Load the approved draft + lead.
 *   2. Re-verify compliance (the founder may have added the lead to the
 *      unsubscribe list between draft + approve) → cancel + status='failed'.
 *   3. Deliver — MOCK in Sprint 8.2 (logs the send). Live SMTP/Sendblue is
 *      deferred to Sprint 9+ (BACKLOG-048); SENDBLUE_LIVE / EMAIL_SMTP_LIVE
 *      throw loud.
 *   4. status='sent', sent_at=now + a delivery cost_event (cost 0 in mock).
 *   5. Threaded Slack confirmation ("✅ Sent to {lead} via {channel}").
 *
 * cost_events.agent_type uses 'outreach' (the agent_kind enum value; the
 * worker is the "Outreach Operator" but the enum predates the longer name).
 *
 * Injectable seams (slack / loadDraft / send) keep tests + demos offline.
 */
const OutreachDeliveryJobSchema = z.object({
  orgId: z.string().uuid(),
  draftId: z.string().uuid(),
  channel: z.enum(['email', 'imessage']),
})

export type OutreachDeliveryJob = z.infer<typeof OutreachDeliveryJobSchema>

export interface OutreachDeliveryResult {
  ok: true
  status: 'sent' | 'unsubscribed_at_send' | 'no_draft'
  draftId: string
  costUsd: number
}

/** What the loader returns — the draft fields the worker needs + lead identity. */
export interface OutreachDeliveryContext {
  leadId: string
  leadName: string
  leadEmail: string | null
  body: string
  subject: string | null
  approvalSlackTs: string | null
  /** Slack DM channel the approval card was posted to (composer stamps it). */
  slackChannelId: string | null
  slackThreadTs: string | null
}

/** Result of a (mock or live) send. */
export interface DeliveryAck {
  providerMessageId: string
}

export interface ProcessOutreachDeliveryOverrides {
  slack?: SlackClient
  loadDraft?: (args: {
    raw: DbClient
    orgId: string
    draftId: string
  }) => Promise<OutreachDeliveryContext | null>
  /** Inject a delivery client (tests/demo). Default: mock log + synthetic id. */
  send?: (args: {
    channel: 'email' | 'imessage'
    recipient: string | null
    subject: string | null
    body: string
  }) => Promise<DeliveryAck>
}

async function loadOutreachDraftFromDb(args: {
  raw: DbClient
  orgId: string
  draftId: string
}): Promise<OutreachDeliveryContext | null> {
  const { raw, orgId, draftId } = args
  const [draft] = await raw
    .select()
    .from(outreachDraftsTable)
    .where(and(eq(outreachDraftsTable.id, draftId), eq(outreachDraftsTable.orgId, orgId)))
  if (!draft) return null

  const [lead] = await raw
    .select({ id: leadsTable.id, fullName: leadsTable.fullName, email: leadsTable.email })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, draft.leadId), eq(leadsTable.orgId, orgId)))

  const meta = (draft.composerMetadata as Record<string, unknown>) ?? {}
  return {
    leadId: draft.leadId,
    leadName: lead?.fullName ?? draft.leadId,
    leadEmail: lead?.email ?? null,
    body: draft.body,
    subject: draft.subject,
    approvalSlackTs: draft.approvalSlackTs,
    slackChannelId: (meta.slackChannelId as string | undefined) ?? null,
    slackThreadTs: (meta.slackThreadTs as string | undefined) ?? null,
  }
}

/** Mock delivery — Sprint 8.2 logs the send and returns a synthetic id. */
function liveDeliveryGuard(channel: 'email' | 'imessage'): void {
  const live =
    (channel === 'email' && process.env.EMAIL_SMTP_LIVE === 'true') ||
    (channel === 'imessage' && process.env.SENDBLUE_LIVE === 'true')
  if (live) {
    throw new Error(
      `[outreach-operator] live ${channel} delivery not implemented in Sprint 8.2 — wire real provider in Sprint 9+ (BACKLOG-048)`,
    )
  }
}

export async function processOutreachDeliveryJob(
  job: { data: OutreachDeliveryJob },
  ctx: WorkerContext,
  overrides: ProcessOutreachDeliveryOverrides = {},
): Promise<OutreachDeliveryResult> {
  const { orgId, draftId, channel } = job.data
  const raw = ctx.db.raw

  // ─── 1. Load draft ─────────────────────────────────────────────────
  const loadDraft = overrides.loadDraft ?? loadOutreachDraftFromDb
  const draftCtx = await loadDraft({ raw, orgId, draftId })
  if (!draftCtx) {
    ctx.logger.warn({ orgId, draftId }, '[outreach-operator] draft not found')
    return { ok: true, status: 'no_draft', draftId, costUsd: 0 }
  }

  // ─── 2. Re-verify compliance (race against composer pre-check) ─────
  if (channel === 'email' && draftCtx.leadEmail) {
    const [suppressed] = await raw
      .select({ id: outreachUnsubscribesTable.id })
      .from(outreachUnsubscribesTable)
      .where(
        and(
          eq(outreachUnsubscribesTable.orgId, orgId),
          eq(outreachUnsubscribesTable.channel, 'email'),
          eq(outreachUnsubscribesTable.identifier, draftCtx.leadEmail),
        ),
      )
    if (suppressed) {
      await raw
        .update(outreachDraftsTable)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(and(eq(outreachDraftsTable.id, draftId), eq(outreachDraftsTable.orgId, orgId)))
      // Explicit (non-silent) ledger entry for the compliance cancel — cost 0,
      // success=false so dashboards surface the suppressed send.
      await raw.insert(costEvents).values({
        orgId,
        runId: null,
        agentType: 'outreach',
        provider: channel === 'email' ? 'resend' : 'sendblue',
        operationType: 'outreach_skipped_unsubscribed',
        costUsd: '0.000000',
        success: false,
        metadata: { lead_id: draftCtx.leadId, draft_id: draftId, reason: 'unsubscribed_at_send' },
      })
      ctx.logger.warn(
        { orgId, draftId, leadEmail: draftCtx.leadEmail },
        '[outreach-operator] unsubscribed_at_send — cancelling delivery',
      )
      return { ok: true, status: 'unsubscribed_at_send', draftId, costUsd: 0 }
    }
  }

  // ─── 3. Deliver (mock-default; live throws) ────────────────────────
  liveDeliveryGuard(channel)
  const recipient = channel === 'email' ? draftCtx.leadEmail : null
  const send =
    overrides.send ??
    (async () => {
      ctx.logger.info(
        { orgId, draftId, channel, recipient, bodyLength: draftCtx.body.length },
        '[outreach-operator] MOCK send',
      )
      return { providerMessageId: `mock-${channel}-${draftId}` }
    })
  const ack = await send({ channel, recipient, subject: draftCtx.subject, body: draftCtx.body })

  // ─── 4. Mark sent + delivery cost_event ────────────────────────────
  await raw
    .update(outreachDraftsTable)
    .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() })
    .where(and(eq(outreachDraftsTable.id, draftId), eq(outreachDraftsTable.orgId, orgId)))

  await raw.insert(costEvents).values({
    orgId,
    runId: null,
    agentType: 'outreach',
    provider: channel === 'email' ? 'resend' : 'sendblue',
    operationType: channel === 'email' ? 'outreach_delivery_email' : 'outreach_delivery_imessage',
    costUsd: '0.000000',
    success: true,
    metadata: { lead_id: draftCtx.leadId, draft_id: draftId, provider_message_id: ack.providerMessageId },
  })

  // ─── 5. Threaded Slack confirmation (best-effort) ──────────────────
  if (draftCtx.slackChannelId && (draftCtx.slackThreadTs || draftCtx.approvalSlackTs)) {
    const slack = overrides.slack ?? (await resolveSlack(orgId, ctx))
    if (slack) {
      await slack.postMessage({
        channel: draftCtx.slackChannelId,
        thread_ts: draftCtx.slackThreadTs ?? draftCtx.approvalSlackTs ?? undefined,
        text: `✅ Sent to *${draftCtx.leadName}* via ${channel}.`,
      })
    }
  }

  ctx.logger.info({ orgId, draftId, channel }, '[outreach-operator] delivered (mock)')
  return { ok: true, status: 'sent', draftId, costUsd: 0 }
}

async function resolveSlack(orgId: string, ctx: WorkerContext): Promise<SlackClient | null> {
  const tokens = await getSlackOAuthTokens(orgId)
  if (!tokens) {
    ctx.logger.warn({ orgId }, '[outreach-operator] no Slack tokens — skipping sent confirmation')
    return null
  }
  return new SlackClient({ token: tokens.bot_token })
}

export const outreachOperatorWorker = defineWorker<OutreachDeliveryJob, OutreachDeliveryResult>({
  queueName: 'outreach-operator',
  jobSchema: OutreachDeliveryJobSchema,
  concurrency: 4,
  idempotencyKey: (job) => `outreach-delivery-${job.draftId}`,
  process: (job, ctx) => processOutreachDeliveryJob(job, ctx),
})

export { OutreachDeliveryJobSchema }
