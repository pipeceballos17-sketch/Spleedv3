import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  getServiceClient,
  icps as icpsTable,
  leadDossiers as leadDossiersTable,
  leads as leadsTable,
  orgs as orgsTable,
  outreachDrafts as outreachDraftsTable,
  outreachReplies as outreachRepliesTable,
  outreachUnsubscribes as outreachUnsubscribesTable,
  scoutRuns,
} from '@spleed/db'
import { ingestLead } from '@spleed/agents'
import {
  profilerWorker,
  scoutWorker,
  registerScoutCronForOrg,
  unregisterScoutCronForOrg,
  pauseScoutCron,
  getScoutCron,
  enqueueConciergeJob,
  enqueueComposerJob,
  enqueueOutreachDelivery,
  waitForJob,
} from '@spleed/agents/workers'
import {
  SlackClient,
  buildReplyNotificationCard,
  getSlackOAuthTokens,
  storeSlackOAuthTokens,
  verifySlackSignature,
  type ReplyIntent,
  type SlackEventEnvelope,
  type SlackMessageImEvent,
} from '@spleed/integrations/slack'
import { AnthropicClient, storeAnthropicApiKey } from '@spleed/integrations/anthropic'
import { ResendClient, storeResendApiKey } from '@spleed/integrations/resend'
import { signOAuthState, verifyOAuthState } from './helpers/slack-oauth-state'
import { verifyReplyWebhook } from './helpers/reply-webhook-signature'
import { startWorkers } from './workers/start'

const port = Number(process.env.API_PORT ?? 3001)

// ─── Auth stub (Sprint 5a) ────────────────────────────────────────────
// TODO Sprint 9: replace x-org-id header stub with proper JWT auth via
// Supabase Auth. The header is trivially spoofable today — accepted only
// because Sprint 5a clients are dev/test only (no public exposure yet).
const ORG_ID_HEADER = 'x-org-id'

function getOrgId(req: Request): { orgId: string } | { error: Response } {
  const raw = req.headers.get(ORG_ID_HEADER)
  if (!raw) {
    return {
      error: Response.json(
        { error: 'MISSING_ORG_ID', message: `Header ${ORG_ID_HEADER} is required` },
        { status: 401 },
      ),
    }
  }
  // Permissive UUID v4 check — Sprint 9 JWT decode will replace this.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return {
      error: Response.json(
        { error: 'INVALID_ORG_ID', message: 'Header value must be a UUID' },
        { status: 401 },
      ),
    }
  }
  return { orgId: raw }
}

// ─── Route handlers ───────────────────────────────────────────────────

const ScoutRunBodySchema = z.object({
  icpId: z.string().uuid(),
  // Sprint 5b: max 100 (down from Sprint 5a's 200). Hard cap matches the
  // LLM_RERANK_CAP in scout.worker.ts so every inserted lead carries a
  // combinedScore (mixing combined vs sql-only scores breaks sort fairness).
  // Sprint 9+ may lift this once Hermes feedback justifies more LLM spend.
  volume: z.number().int().positive().max(100).default(50),
})

/**
 * POST /api/scout/run — enqueue a Scout run for an ICP.
 * Returns 200 { runId, status: 'queued' } immediately (async execution).
 */
async function postScoutRun(req: Request): Promise<Response> {
  const auth = getOrgId(req)
  if ('error' in auth) return auth.error

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json(
      { error: 'INVALID_JSON', message: 'Request body must be valid JSON' },
      { status: 400 },
    )
  }
  const parsed = ScoutRunBodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'INVALID_BODY', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const { icpId, volume } = parsed.data
  const db = getServiceClient()

  // Verify ICP exists AND belongs to the requesting org. Combined check —
  // either condition failing returns 404 (don't leak ICP existence to
  // adjacent orgs).
  const icpRows = await db
    .select({ id: icpsTable.id })
    .from(icpsTable)
    .where(and(eq(icpsTable.id, icpId), eq(icpsTable.orgId, auth.orgId)))
  if (icpRows.length === 0) {
    return Response.json(
      { error: 'ICP_NOT_FOUND', message: `ICP ${icpId} not found for this org` },
      { status: 404 },
    )
  }

  // Create the scout_runs row first (status='queued'), then enqueue the job.
  const [run] = await db
    .insert(scoutRuns)
    .values({
      orgId: auth.orgId,
      icpId,
      status: 'queued',
      triggerType: 'on_demand',
      requestedVolume: volume,
    })
    .returning({ id: scoutRuns.id })

  if (!run) {
    return Response.json(
      { error: 'INSERT_FAILED', message: 'Failed to create scout_runs row' },
      { status: 500 },
    )
  }

  await scoutWorker.enqueue({
    runId: run.id,
    orgId: auth.orgId,
    icpId,
    requestedVolume: volume,
    triggerType: 'on_demand',
  })

  return Response.json({ runId: run.id, status: 'queued' }, { status: 200 })
}

/**
 * GET /api/scout/runs/:runId — read the current state of a scout run.
 * 404 if the run doesn't exist OR belongs to a different org (don't leak).
 */
async function getScoutRun(req: Request, runId: string): Promise<Response> {
  const auth = getOrgId(req)
  if ('error' in auth) return auth.error

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    return Response.json(
      { error: 'INVALID_RUN_ID', message: 'runId must be a UUID' },
      { status: 400 },
    )
  }

  const db = getServiceClient()
  const rows = await db
    .select()
    .from(scoutRuns)
    .where(and(eq(scoutRuns.id, runId), eq(scoutRuns.orgId, auth.orgId)))

  const run = rows[0]
  if (!run) {
    return Response.json(
      { error: 'RUN_NOT_FOUND', message: `scout_run ${runId} not found for this org` },
      { status: 404 },
    )
  }

  return Response.json(
    {
      id: run.id,
      status: run.status,
      requestedVolume: run.requestedVolume,
      apolloCandidatesFound: run.apolloCandidatesFound,
      sqlFilteredCount: run.sqlFilteredCount,
      leadsInsertedCount: run.leadsInsertedCount,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      errorSummary: run.errorSummary,
    },
    { status: 200 },
  )
}

// ─── ICP cron management (Sprint 5b CP2) ──────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function requireIcpOwnership(
  icpId: string,
  orgId: string,
): Promise<Response | null> {
  if (!UUID_RE.test(icpId)) {
    return Response.json(
      { error: 'INVALID_ICP_ID', message: 'icpId must be a UUID' },
      { status: 400 },
    )
  }
  const db = getServiceClient()
  const rows = await db
    .select({ id: icpsTable.id })
    .from(icpsTable)
    .where(and(eq(icpsTable.id, icpId), eq(icpsTable.orgId, orgId)))
  if (rows.length === 0) {
    return Response.json(
      { error: 'ICP_NOT_FOUND', message: `ICP ${icpId} not found for this org` },
      { status: 404 },
    )
  }
  return null
}

async function postActivateCron(req: Request, icpId: string): Promise<Response> {
  const auth = getOrgId(req)
  if ('error' in auth) return auth.error
  const ownership = await requireIcpOwnership(icpId, auth.orgId)
  if (ownership) return ownership

  const schedulerId = await registerScoutCronForOrg(auth.orgId, icpId)
  const scheduler = await getScoutCron(auth.orgId, icpId)
  return Response.json(
    {
      schedulerId,
      pattern: scheduler?.pattern,
      tz: scheduler?.tz,
      nextFireAt: scheduler?.nextFireAt,
    },
    { status: 200 },
  )
}

async function postPauseCron(req: Request, icpId: string): Promise<Response> {
  const auth = getOrgId(req)
  if ('error' in auth) return auth.error
  const ownership = await requireIcpOwnership(icpId, auth.orgId)
  if (ownership) return ownership

  const removed = await pauseScoutCron(auth.orgId, icpId)
  return Response.json({ paused: removed }, { status: 200 })
}

async function deleteCron(req: Request, icpId: string): Promise<Response> {
  const auth = getOrgId(req)
  if ('error' in auth) return auth.error
  const ownership = await requireIcpOwnership(icpId, auth.orgId)
  if (ownership) return ownership

  const removed = await unregisterScoutCronForOrg(auth.orgId, icpId)
  return Response.json({ removed }, { status: 200 })
}

// ─── Profiler endpoints (Sprint 6a) ───────────────────────────────────

/**
 * GET /api/leads/:id/dossier — read Profiler enrichment state for a lead.
 *
 * State derivation (Sprint 6 Decision 1: leads.status is the single source
 * of truth; lead_dossiers has no status column):
 *   - dossier row absent + lead.status='discovered'  → 'not_started'
 *   - dossier row absent + lead.status='enriching'   → 'in_progress'
 *     (rare race: worker has updated status but not yet upserted dossier)
 *   - dossier row present                            → full row + derived status
 */
async function getLeadDossier(req: Request, leadId: string): Promise<Response> {
  const auth = getOrgId(req)
  if ('error' in auth) return auth.error

  if (!UUID_RE.test(leadId)) {
    return Response.json(
      { error: 'INVALID_LEAD_ID', message: 'leadId must be a UUID' },
      { status: 400 },
    )
  }

  const db = getServiceClient()

  const [lead] = await db
    .select({ id: leadsTable.id, status: leadsTable.status })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, auth.orgId)))
  if (!lead) {
    return Response.json(
      { error: 'LEAD_NOT_FOUND', message: `Lead ${leadId} not found for this org` },
      { status: 404 },
    )
  }

  const [dossier] = await db
    .select()
    .from(leadDossiersTable)
    .where(
      and(
        eq(leadDossiersTable.leadId, leadId),
        eq(leadDossiersTable.orgId, auth.orgId),
      ),
    )

  if (!dossier) {
    // Per Decision 1: derive state from lead.status when no dossier row
    // exists. 'enriching' here means the worker started but didn't yet
    // upsert the dossier seed row — narrow window but observable.
    const derived =
      lead.status === 'enriching' ? 'in_progress' : 'not_started'
    return Response.json({ leadId, status: derived }, { status: 200 })
  }

  return Response.json(
    {
      leadId: dossier.leadId,
      // Derived status: 'enriched' once a dossier row exists. If the lead
      // status reverted (e.g. mid-failure cleanup) we still see the dossier
      // briefly here — Profiler's catch path DELETEs the dossier on failure,
      // so this state shouldn't outlive a single failed run.
      status: lead.status === 'enriching' ? 'in_progress' : 'enriched',
      pains: dossier.pains,
      interests: dossier.interests,
      giftSignals: dossier.giftSignals,
      recentChanges: dossier.recentChanges,
      evidenceUrls: dossier.evidenceUrls,
      preferredChannel: dossier.preferredChannel,
      toneMatch: dossier.toneMatch,
      rawSignals: dossier.rawSignals,
      confidenceScore: dossier.confidenceScore,
      isStale: dossier.isStale,
      enrichedBy: dossier.enrichedBy,
      createdAt: dossier.createdAt,
      updatedAt: dossier.updatedAt,
    },
    { status: 200 },
  )
}

/**
 * POST /api/profiler/run-lead/:leadId — manually enqueue a Profiler job.
 * 409 if the lead is already mid-enrichment (leads.status='enriching').
 */
async function postProfilerRunLead(req: Request, leadId: string): Promise<Response> {
  const auth = getOrgId(req)
  if ('error' in auth) return auth.error

  if (!UUID_RE.test(leadId)) {
    return Response.json(
      { error: 'INVALID_LEAD_ID', message: 'leadId must be a UUID' },
      { status: 400 },
    )
  }

  const db = getServiceClient()

  const [lead] = await db
    .select({ id: leadsTable.id, status: leadsTable.status })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.orgId, auth.orgId)))
  if (!lead) {
    return Response.json(
      { error: 'LEAD_NOT_FOUND', message: `Lead ${leadId} not found for this org` },
      { status: 404 },
    )
  }

  // Conflict: an enrichment is already in flight. Idempotency at the BullMQ
  // layer would dedupe by jobId, but the API returns 409 explicitly so the
  // caller knows the prior job is still running instead of silently no-oping.
  if (lead.status === 'enriching') {
    return Response.json(
      {
        error: 'PROFILER_ALREADY_RUNNING',
        message: `Lead ${leadId} is already being enriched`,
      },
      { status: 409 },
    )
  }

  await profilerWorker.enqueue({
    leadId,
    orgId: auth.orgId,
    triggerType: 'manual',
  })

  // The Profiler worker's idempotencyKey is `profiler-${leadId}`. Expose it
  // so callers polling GET /dossier or tailing logs can correlate.
  return Response.json(
    { profilerJobId: `profiler-${leadId}`, status: 'queued' },
    { status: 200 },
  )
}

// ─── Manual lead ingest (Sprint 7a) ───────────────────────────────────

/**
 * Payload for POST /api/leads/ingest. All identity fields optional —
 * caller can ingest from URL alone (Profiler enrichment fills the rest).
 * Validation that at least one of (linkedinUrl|companyDomain|name) is
 * present happens post-normalize in the handler (a string input like
 * `"not a domain"` normalizes to null).
 */
const IngestPayloadSchema = z.object({
  linkedinUrl: z.string().optional(),
  companyDomain: z.string().optional(),
  name: z.string().min(2).max(200).optional(),
  title: z.string().max(200).optional(),
  icpId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
})

const INGEST_TIMEOUT_DEFAULT_MS = 60_000
const INGEST_TIMEOUT_MAX_MS = 90_000
const INGEST_TIMEOUT_MIN_MS = 1_000

/**
 * POST /api/leads/ingest — manual lead ingest from founder workflow.
 *
 * Thin HTTP wrapper over the shared ingestLead() core (@spleed/agents) — the
 * SAME normalize → resolve-ICP → dedupe → insert/upsert → enqueue-Profiler
 * logic the concierge worker (Sprint 7c) runs. This handler owns only the
 * HTTP concerns: auth, body validation, ?wait sync mode, and mapping the
 * discriminated IngestLeadResult to status codes.
 *
 * Behavior matrix (unchanged from Sprint 7a):
 *   - New lead + icpId: 201 { leadId, profilerJobId, status: 'queued' }
 *   - New lead + no icpId: 201 { leadId, status: 'parked_no_icp' }
 *   - Existing match + status='discovered': 200 { leadId, status: 'already_exists', mode: 're_enriching' }
 *   - Existing match + status='enriched': 200 { leadId, status: 'already_exists', mode: 'cached' }
 *   - ?wait=true + completed: 201 { leadId, dossier }
 *   - ?wait=true + timeout: 202 { leadId, status: 'in_progress' }
 *   - ?wait=true + job failed: 201 { leadId, status: 'failed', error }
 *   - 400 INVALID_PAYLOAD if no valid input after normalize
 *   - 403 ICP_NOT_IN_ORG if explicit icpId belongs to another org
 */
async function postLeadIngest(req: Request): Promise<Response> {
  const auth = getOrgId(req)
  if ('error' in auth) return auth.error

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json(
      { error: 'INVALID_JSON', message: 'Request body must be valid JSON' },
      { status: 400 },
    )
  }
  const parsed = IngestPayloadSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'INVALID_BODY', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  // Sync-mode query params. timeoutMs clamped to [1000, 90000].
  const url = new URL(req.url)
  const wait = url.searchParams.get('wait') === 'true'
  const timeoutMsRaw = parseInt(
    url.searchParams.get('timeoutMs') ?? `${INGEST_TIMEOUT_DEFAULT_MS}`,
    10,
  )
  const timeoutMs = Number.isFinite(timeoutMsRaw)
    ? Math.min(INGEST_TIMEOUT_MAX_MS, Math.max(INGEST_TIMEOUT_MIN_MS, timeoutMsRaw))
    : INGEST_TIMEOUT_DEFAULT_MS

  // Shared core — same logic the concierge worker runs (Sprint 7c CP3).
  const result = await ingestLead({
    orgId: auth.orgId,
    linkedinUrl: parsed.data.linkedinUrl,
    companyDomain: parsed.data.companyDomain,
    name: parsed.data.name,
    title: parsed.data.title,
    notes: parsed.data.notes,
    icpId: parsed.data.icpId,
    ingestSource: 'manual_url',
  })

  if (result.outcome === 'invalid_payload') {
    return Response.json(
      {
        error: 'INVALID_PAYLOAD',
        message:
          'At least one of linkedinUrl, companyDomain, or name is required (after normalization)',
      },
      { status: 400 },
    )
  }
  if (result.outcome === 'icp_not_in_org') {
    return Response.json(
      { error: 'ICP_NOT_IN_ORG', message: `ICP ${result.requestedIcpId} not found for this org` },
      { status: 403 },
    )
  }

  const db = getServiceClient()

  // Shared sync-wait: on completion fetch the dossier inline. `extra` carries
  // path-specific fields (profilerJobId for the INSERT path, nothing for the
  // UPSERT path) so response shapes match Sprint 7a exactly.
  const waitAndRespond = async (
    leadId: string,
    profilerJobId: string,
    okStatus: 200 | 201,
    extra: Record<string, unknown>,
  ): Promise<Response> => {
    const waitResult = await waitForJob({ queueName: 'profiler', jobId: profilerJobId, timeoutMs })
    if (waitResult.status === 'completed') {
      const [dossier] = await db
        .select()
        .from(leadDossiersTable)
        .where(eq(leadDossiersTable.leadId, leadId))
      return Response.json({ leadId, ...extra, status: 'completed', dossier }, { status: okStatus })
    }
    if (waitResult.status === 'failed') {
      return Response.json(
        { leadId, ...extra, status: 'failed', error: waitResult.error },
        { status: okStatus },
      )
    }
    // timeout — caller can poll GET /api/leads/:id/dossier
    return Response.json({ leadId, ...extra, status: 'in_progress' }, { status: 202 })
  }

  if (result.outcome === 'existing') {
    if (wait && result.profilerEnqueued && result.profilerJobId) {
      return waitAndRespond(result.leadId, result.profilerJobId, 200, {})
    }
    return Response.json(
      {
        leadId: result.leadId,
        status: 'already_exists',
        mode: result.mode,
        manualIngestCount: result.manualIngestCount,
      },
      { status: 200 },
    )
  }

  // result.outcome === 'inserted'
  if (!result.profilerEnqueued || !result.profilerJobId) {
    // No ICP associated → lead parked, no Profiler job enqueued.
    return Response.json({ leadId: result.leadId, status: 'parked_no_icp' }, { status: 201 })
  }
  if (wait) {
    return waitAndRespond(result.leadId, result.profilerJobId, 201, {
      profilerJobId: result.profilerJobId,
    })
  }
  return Response.json(
    { leadId: result.leadId, profilerJobId: result.profilerJobId, status: 'queued' },
    { status: 201 },
  )
}

// ─── Slack OAuth + events (Sprint 7c) ─────────────────────────────────

/**
 * Resolve the OAuth redirect URI Slack must call back. Must match the value
 * registered in the Slack app's OAuth settings exactly. Sprint 7c reads it
 * from env with a localhost dev default.
 */
function slackRedirectUri(): string {
  return (
    process.env.SLACK_OAUTH_REDIRECT_URI ??
    `http://localhost:${port}/api/slack/oauth/callback`
  )
}

/**
 * Minimal HTML confirmation page. The frontend /slack/connected route
 * doesn't exist in Sprint 7c (backend-first per CLAUDE.md §3), so we return
 * a self-contained success page instead of redirecting to a dead route.
 */
function slackConnectedHtml(teamName: string | undefined): Response {
  const safeName = (teamName ?? 'your workspace').replace(/[<>&]/g, '')
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Spleed · Slack connected</title>` +
      `<body style="font-family:system-ui;padding:48px;max-width:480px">` +
      `<h1>✅ Slack connected</h1>` +
      `<p>Spleed is now installed in <strong>${safeName}</strong>. ` +
      `DM the bot a lead (e.g. "who is Sarah Chen from PulseAnalytics") to get a dossier.</p>` +
      `</body>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

/**
 * GET /api/slack/oauth/callback?code=&state= — finish workspace install.
 *
 * 1. Verify the signed state (CSRF guard) → orgId.
 * 2. Exchange the code for bot/user tokens (mock-default).
 * 3. Store tokens in Vault (mock-default in-process store).
 * 4. Stamp orgs.slack_team_id / slack_bot_user_id / slack_connected_at —
 *    the index Slack event handlers use to map team_id → org.
 */
/**
 * Bot scopes the concierge needs: post DMs (chat:write / im:write), read DM
 * events (im:history / im:read), resolve users (users:read), and read team
 * metadata (team:read) for the connected confirmation.
 */
const SLACK_OAUTH_SCOPES = 'chat:write,im:history,im:read,im:write,users:read,team:read'

/**
 * GET /api/slack/install?orgId=<uuid> — start the Slack OAuth install.
 *
 * Signs a state param binding the flow to orgId (CSRF guard, verified by the
 * callback) and 302-redirects to Slack's authorize URL. This is the producer
 * of the signed state the callback consumes — closes the OAuth lifecycle.
 */
async function getSlackInstall(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const orgId = url.searchParams.get('orgId')
  if (!orgId) {
    return Response.json(
      { error: 'MISSING_ORG_ID', message: 'Query param orgId is required' },
      { status: 400 },
    )
  }
  if (!UUID_RE.test(orgId)) {
    return Response.json(
      { error: 'INVALID_ORG_ID', message: 'orgId must be a UUID' },
      { status: 400 },
    )
  }

  const db = getServiceClient()
  const [org] = await db
    .select({ id: orgsTable.id })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId))
  if (!org) {
    return Response.json(
      { error: 'ORG_NOT_FOUND', message: `Org ${orgId} not found` },
      { status: 404 },
    )
  }

  const clientId = process.env.SLACK_CLIENT_ID
  if (!clientId) {
    console.error('[GET /api/slack/install] SLACK_CLIENT_ID not set')
    return Response.json({ error: 'INTERNAL' }, { status: 500 })
  }

  const state = signOAuthState(orgId)
  const authorize = new URL('https://slack.com/oauth/v2/authorize')
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('scope', SLACK_OAUTH_SCOPES)
  authorize.searchParams.set('state', state)
  authorize.searchParams.set('redirect_uri', slackRedirectUri())

  return Response.redirect(authorize.toString(), 302)
}

async function getSlackOAuthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url)

  // Slack reports user-denied installs via ?error=access_denied.
  const slackError = url.searchParams.get('error')
  if (slackError) {
    return Response.json(
      { error: 'SLACK_OAUTH_FAILED', message: `Slack returned: ${slackError}` },
      { status: 400 },
    )
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code) {
    return Response.json(
      { error: 'SLACK_OAUTH_FAILED', message: 'Missing code param' },
      { status: 400 },
    )
  }

  const verified = verifyOAuthState(state)
  if (!verified) {
    return Response.json(
      { error: 'INVALID_STATE', message: 'OAuth state missing, tampered, or expired' },
      { status: 400 },
    )
  }
  const { orgId } = verified

  // Exchange code → tokens. SlackClient is constructed without a bot token
  // (we don't have one yet); the OAuth exchange is what yields it.
  const slack = new SlackClient({ token: '' })
  const tokens = await slack.exchangeOAuthCode(code, slackRedirectUri())

  await storeSlackOAuthTokens(orgId, tokens)

  const db = getServiceClient()
  await db
    .update(orgsTable)
    .set({
      slackTeamId: tokens.team_id,
      slackBotUserId: tokens.bot_user_id,
      slackConnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(orgsTable.id, orgId))

  return slackConnectedHtml(tokens.team_name)
}

/**
 * POST /api/slack/events — Slack Events API webhook.
 *
 * Signature verification needs the UNPARSED body, so we read req.text()
 * once and JSON.parse it ourselves (Request bodies are single-read). Returns
 * 200 fast on every accepted event — concierge work happens async (CP3) so
 * Slack doesn't retry on our processing latency.
 */
async function postSlackEvents(req: Request): Promise<Response> {
  const rawBody = await req.text()

  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (!signingSecret) {
    console.error('[POST /api/slack/events] SLACK_SIGNING_SECRET not set')
    return Response.json({ error: 'INTERNAL' }, { status: 500 })
  }

  const valid = verifySlackSignature({
    signingSecret,
    timestamp: req.headers.get('x-slack-request-timestamp'),
    signature: req.headers.get('x-slack-signature'),
    rawBody,
  })
  if (!valid) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: SlackEventEnvelope
  try {
    body = JSON.parse(rawBody) as SlackEventEnvelope
  } catch {
    return Response.json(
      { error: 'INVALID_JSON', message: 'Body must be valid JSON' },
      { status: 400 },
    )
  }

  // URL verification handshake — Slack sends this once on event subscription.
  if (body.type === 'url_verification') {
    return Response.json({ challenge: body.challenge }, { status: 200 })
  }

  if (body.type === 'event_callback' && body.event) {
    const event = body.event
    const isFreshUserDm =
      event.type === 'message' &&
      (event as SlackMessageImEvent).channel_type === 'im' &&
      !(event as SlackMessageImEvent).bot_id &&
      !(event as SlackMessageImEvent).subtype
    if (isFreshUserDm) {
      const dm = event as SlackMessageImEvent
      const teamId = body.team_id

      // Map the Slack workspace → org. Unknown workspace = graceful 200
      // (could be a stale install or a workspace we no longer serve; never
      // surface internal state to an unknown caller).
      const db = getServiceClient()
      const [org] = teamId
        ? await db
            .select({ id: orgsTable.id })
            .from(orgsTable)
            .where(eq(orgsTable.slackTeamId, teamId))
        : []

      if (org) {
        // Enqueue the concierge job. The worker (Sprint 7c) runs
        // parseConciergeQuery → ingestLead → waits on Profiler → posts the
        // dossier Block Kit card back as a threaded reply. Idempotency key
        // `concierge-{orgId}-{ts}` dedupes Slack's at-least-once delivery.
        await enqueueConciergeJob({
          orgId: org.id,
          slackChannelId: dm.channel,
          slackUserId: dm.user,
          slackThreadTs: dm.ts,
          text: dm.text,
        })
      }
    }
  }

  // Always 200 fast — Slack retries (with backoff) on any non-2xx.
  return new Response('', { status: 200 })
}

/**
 * POST /api/slack/interactions — Block Kit button clicks on the Composer
 * approval card (Sprint 8.2).
 *
 * Slack sends `application/x-www-form-urlencoded` with a single `payload`
 * field holding the JSON. Signature verification needs the UNPARSED body
 * (same as /events), so we read req.text() once and parse it ourselves.
 *
 * Routes by action_id (each button carries the draftId as `value`):
 *   approve_draft    → mark approved (CP2 wires the delivery enqueue)
 *   edit_draft       → Sprint 9 dashboard edit (ack for now)
 *   regenerate_draft → enqueueComposerJob(mode='regenerate')
 *   reject_draft     → mark rejected
 */
async function postSlackInteractions(req: Request): Promise<Response> {
  const rawBody = await req.text()

  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (!signingSecret) {
    console.error('[POST /api/slack/interactions] SLACK_SIGNING_SECRET not set')
    return Response.json({ error: 'INTERNAL' }, { status: 500 })
  }
  const valid = verifySlackSignature({
    signingSecret,
    timestamp: req.headers.get('x-slack-request-timestamp'),
    signature: req.headers.get('x-slack-signature'),
    rawBody,
  })
  if (!valid) return new Response('Unauthorized', { status: 401 })

  // Form-encoded: payload=<url-encoded JSON>.
  const payloadRaw = new URLSearchParams(rawBody).get('payload')
  if (!payloadRaw) {
    return Response.json({ error: 'MISSING_PAYLOAD' }, { status: 400 })
  }
  let payload: {
    type?: string
    channel?: { id?: string }
    message?: { ts?: string; thread_ts?: string }
    actions?: Array<{ action_id: string; value?: string }>
  }
  try {
    payload = JSON.parse(payloadRaw)
  } catch {
    return Response.json({ error: 'INVALID_PAYLOAD' }, { status: 400 })
  }

  const action = payload.actions?.[0]
  if (!action) return new Response('', { status: 200 })
  const value = action.value
  if (!value) {
    return Response.json({ text: "I couldn't tell which item that was." }, { status: 200 })
  }

  const db = getServiceClient()

  // ─── Reply-card actions (value = outreach_replies.id) ──────────────
  const REPLY_ACTIONS = new Set(['mark_engaged', 'draft_reply', 'archive_reply'])
  if (REPLY_ACTIONS.has(action.action_id)) {
    const [reply] = await db
      .select()
      .from(outreachRepliesTable)
      .where(eq(outreachRepliesTable.id, value))
    if (!reply) {
      return Response.json({ text: 'That reply no longer exists.' }, { status: 200 })
    }
    // parsed_intent enum has no 'engaged_confirmed' / 'archived' states, so
    // founder confirmations are recorded in raw_payload jsonb (no migration).
    const existingPayload = (reply.rawPayload as Record<string, unknown>) ?? {}
    const nowIso = new Date().toISOString()
    switch (action.action_id) {
      case 'mark_engaged':
        await db
          .update(outreachRepliesTable)
          .set({ rawPayload: { ...existingPayload, founderAction: 'engaged_confirmed', confirmedAt: nowIso } })
          .where(eq(outreachRepliesTable.id, value))
        return Response.json({ text: '✅ Marked as engaged.' }, { status: 200 })
      case 'archive_reply':
        await db
          .update(outreachRepliesTable)
          .set({ rawPayload: { ...existingPayload, archivedAt: nowIso } })
          .where(eq(outreachRepliesTable.id, value))
        return Response.json({ text: '🗂 Archived.' }, { status: 200 })
      default: // draft_reply
        return Response.json(
          { text: 'Drafting a reply lands Sprint 9 — for now reply manually or from the dashboard.' },
          { status: 200 },
        )
    }
  }

  // ─── Draft-card actions (value = outreach_drafts.id) ───────────────
  const [draft] = await db
    .select()
    .from(outreachDraftsTable)
    .where(eq(outreachDraftsTable.id, value))
  if (!draft) {
    return Response.json({ text: 'That draft no longer exists.' }, { status: 200 })
  }
  const draftId = value

  switch (action.action_id) {
    case 'approve_draft': {
      await db
        .update(outreachDraftsTable)
        .set({ status: 'approved', approvedAt: new Date(), updatedAt: new Date() })
        .where(eq(outreachDraftsTable.id, draftId))
      // Hand off to the Outreach Operator. Composer only writes email|imessage;
      // narrow the broader channel enum defensively.
      await enqueueOutreachDelivery({
        orgId: draft.orgId,
        draftId,
        channel: draft.channel === 'imessage' ? 'imessage' : 'email',
      })
      return Response.json({ text: '✅ Approved — sending shortly.' }, { status: 200 })
    }
    case 'edit_draft': {
      return Response.json(
        {
          text: 'Editing in Slack lands Sprint 9 — for now edit in the dashboard, or tap 🔄 Regenerate.',
        },
        { status: 200 },
      )
    }
    case 'regenerate_draft': {
      await enqueueComposerJob({
        orgId: draft.orgId,
        leadId: draft.leadId,
        mode: 'regenerate',
        supersedesDraftId: draftId,
        slackChannelId: payload.channel?.id,
        slackThreadTs: payload.message?.thread_ts ?? payload.message?.ts,
      })
      return Response.json({ text: '🔄 Regenerating the draft…' }, { status: 200 })
    }
    case 'reject_draft': {
      await db
        .update(outreachDraftsTable)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(eq(outreachDraftsTable.id, draftId))
      return Response.json({ text: '❌ Draft rejected.' }, { status: 200 })
    }
    default:
      return new Response('', { status: 200 })
  }
}

// ─── Inbound reply webhook (Sprint 8.2) ───────────────────────────────

const ReplyWebhookSchema = z.object({
  lead_id: z.string().uuid().optional(),
  lead_email: z.string().optional(),
  message_id: z.string().optional(),
  body: z.string().min(1),
  received_at: z.string(),
  source: z.enum(['sendblue', 'email_imap', 'manual_forward', 'mock']),
})

/**
 * Simple keyword intent classifier (Sprint 8.2). Hermes refines this in
 * Sprint 9+ (BACKLOG-049). Order matters: unsubscribe wins over everything.
 */
function classifyReplyIntent(body: string): 'unsubscribe' | 'engaged' | 'declined' | null {
  if (/\b(stop|baja|unsubscribe|desuscribir)\b/i.test(body)) return 'unsubscribe'
  // Declined BEFORE engaged: "not interested" contains "interested", so the
  // negation must win over the positive keyword.
  if (/(no,? thanks|not interested|no gracias|no me interesa)/i.test(body)) return 'declined'
  if (/(interested|let'?s chat|tell me more|interesa|hablemos)/i.test(body)) return 'engaged'
  return null
}

/**
 * POST /api/outreach/reply-webhook — inbound reply ingest (Sprint 8.2 mock).
 *
 * Signed with REPLY_WEBHOOK_SECRET (HMAC, replay window). Classifies intent,
 * records the reply, auto-suppresses on STOP, and notifies the founder in
 * Slack (threaded under the draft's approval thread when known).
 */
async function postOutreachReplyWebhook(req: Request): Promise<Response> {
  const rawBody = await req.text()
  if (
    !verifyReplyWebhook({
      rawBody,
      signature: req.headers.get('x-spleed-reply-signature'),
      timestamp: req.headers.get('x-spleed-reply-timestamp'),
    })
  ) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return Response.json({ error: 'INVALID_JSON' }, { status: 400 })
  }
  const parsed = ReplyWebhookSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'INVALID_BODY', issues: parsed.error.issues }, { status: 400 })
  }
  const p = parsed.data
  if (!p.lead_id && !p.lead_email) {
    return Response.json(
      { error: 'INVALID_BODY', message: 'lead_id or lead_email is required' },
      { status: 400 },
    )
  }

  const db = getServiceClient()

  // Lead lookup — lead_id is globally unique (gives org unambiguously);
  // lead_email falls back to the most recent matching lead (best-effort,
  // Sprint 9+ ties replies to a per-org webhook secret).
  const [lead] = p.lead_id
    ? await db
        .select({ id: leadsTable.id, orgId: leadsTable.orgId, fullName: leadsTable.fullName, email: leadsTable.email })
        .from(leadsTable)
        .where(eq(leadsTable.id, p.lead_id))
    : await db
        .select({ id: leadsTable.id, orgId: leadsTable.orgId, fullName: leadsTable.fullName, email: leadsTable.email })
        .from(leadsTable)
        .where(eq(leadsTable.email, p.lead_email!))
        .orderBy(desc(leadsTable.createdAt))
        .limit(1)
  if (!lead) {
    return Response.json({ error: 'LEAD_NOT_FOUND' }, { status: 404 })
  }

  // Most recent sent draft (links the reply + carries Slack thread context).
  const [recentDraft] = await db
    .select()
    .from(outreachDraftsTable)
    .where(
      and(
        eq(outreachDraftsTable.leadId, lead.id),
        eq(outreachDraftsTable.orgId, lead.orgId),
        eq(outreachDraftsTable.status, 'sent'),
      ),
    )
    .orderBy(desc(outreachDraftsTable.sentAt))
    .limit(1)

  const intent = classifyReplyIntent(p.body)

  const [replyRow] = await db
    .insert(outreachRepliesTable)
    .values({
      orgId: lead.orgId,
      leadId: lead.id,
      draftId: recentDraft?.id ?? null,
      sourceProvider: p.source,
      receivedAt: new Date(p.received_at),
      body: p.body,
      parsedIntent: intent, // null when unclassified
      rawPayload: p as Record<string, unknown>,
    })
    .returning({ id: outreachRepliesTable.id })
  const replyId = replyRow!.id

  // Resolve Slack thread context from the draft's composer_metadata.
  const meta = (recentDraft?.composerMetadata as Record<string, unknown>) ?? {}
  const slackChannelId = (meta.slackChannelId as string | undefined) ?? null
  const slackThreadTs =
    (meta.slackThreadTs as string | undefined) ?? recentDraft?.approvalSlackTs ?? null

  const notify = async (text: string, blocks?: Parameters<SlackClient['postMessage']>[0]['blocks']) => {
    if (!slackChannelId) return
    const tokens = await getSlackOAuthTokens(lead.orgId)
    if (!tokens) return
    try {
      await new SlackClient({ token: tokens.bot_token }).postMessage({
        channel: slackChannelId,
        thread_ts: slackThreadTs ?? undefined,
        text,
        blocks,
      })
    } catch (err) {
      console.error('[reply-webhook] slack notify failed', err)
    }
  }

  if (intent === 'unsubscribe') {
    if (lead.email) {
      await db
        .insert(outreachUnsubscribesTable)
        .values({ orgId: lead.orgId, channel: 'email', identifier: lead.email, source: 'reply_stop' })
        .onConflictDoNothing()
    }
    await notify(`🚫 *${lead.fullName ?? lead.id}* unsubscribed via reply.`)
  } else {
    // 'declined' and unclassified (null → 'other') both render FYI (no buttons).
    const cardIntent: ReplyIntent =
      intent === 'engaged' ? 'engaged' : intent === 'declined' ? 'declined' : 'other'
    const blocks = buildReplyNotificationCard({
      replyId,
      leadName: lead.fullName ?? lead.id,
      replyBody: p.body,
      intent: cardIntent,
    })
    await notify(`📬 ${lead.fullName ?? lead.id} replied`, blocks)
  }

  return Response.json({ replyId, parsedIntent: intent }, { status: 200 })
}

// ─── Anthropic guided BYOK (Sprint 8.2 — Decision 9) ──────────────────

/**
 * GET /api/anthropic/install?orgId=<uuid> — self-contained setup wizard.
 * Sprint 9-10 replaces this with a dashboard React flow; for now it's plain
 * HTML+CSS+vanilla JS that POSTs the key to /api/anthropic/verify-key.
 */
async function getAnthropicInstall(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const orgId = url.searchParams.get('orgId')
  if (!orgId || !UUID_RE.test(orgId)) {
    return Response.json({ error: 'INVALID_ORG_ID', message: 'orgId (UUID) query param required' }, { status: 400 })
  }
  const db = getServiceClient()
  const [org] = await db.select({ id: orgsTable.id }).from(orgsTable).where(eq(orgsTable.id, orgId))
  if (!org) {
    return Response.json({ error: 'ORG_NOT_FOUND', message: `Org ${orgId} not found` }, { status: 404 })
  }

  const html = `<!doctype html><meta charset="utf-8"><title>Connect Claude · Spleed</title>
<style>
  body{font-family:system-ui;max-width:560px;margin:40px auto;padding:0 20px;color:#0A0A0A;line-height:1.5}
  h1{font-size:1.6rem} ol{padding-left:1.2rem} li{margin:.5rem 0}
  code{background:#FAFAF9;border:1px solid #e5e5e5;border-radius:6px;padding:1px 6px;font-size:.9em}
  input{width:100%;padding:10px;border:1px solid #d4d4d4;border-radius:8px;font-family:monospace;margin:8px 0}
  button{background:#FF6B35;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:1rem;cursor:pointer}
  #msg{margin-top:14px;font-weight:600} .ok{color:#16A34A} .err{color:#DC2626}
  .note{color:#71717A;font-size:.85rem;margin-top:18px}
</style>
<h1>Connect your Claude key</h1>
<ol>
  <li>Go to <code>console.anthropic.com</code> → Settings → API Keys</li>
  <li>Click <strong>Create Key</strong>, name it <strong>Spleed</strong>, and copy it</li>
  <li>Paste it below and click Connect</li>
</ol>
<input id="key" type="password" placeholder="sk-ant-..." autocomplete="off" />
<button onclick="verify()">Connect</button>
<div id="msg"></div>
<p class="note">Your key is encrypted in Spleed Vault and used only for your LLM calls. Costs stay visible in your Anthropic Console.</p>
<script>
  async function verify(){
    const msg=document.getElementById('msg'); msg.textContent='Verifying…'; msg.className='';
    const apiKey=document.getElementById('key').value.trim();
    try{
      const r=await fetch('/api/anthropic/verify-key',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orgId:${JSON.stringify(orgId)},apiKey})});
      const d=await r.json();
      if(d.success){msg.textContent='✅ '+d.message+(d.plan_detected?(' ('+d.plan_detected+')'):'');msg.className='ok';}
      else{msg.textContent='❌ '+(d.error||'Failed');msg.className='err';}
    }catch(e){msg.textContent='❌ Network error';msg.className='err';}
  }
</script>`
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

const AnthropicVerifyKeySchema = z.object({
  orgId: z.string().uuid(),
  apiKey: z.string().min(1),
})

/**
 * POST /api/anthropic/verify-key — validate + store a tenant's Claude key.
 * Mock-default testConnection accepts `sk-ant-test-*`; live (Sprint 9+) pings
 * the real Messages API. On success: Vault store + orgs.anthropic_vault_ref/
 * anthropic_connected_at.
 */
async function postAnthropicVerifyKey(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ success: false, error: 'INVALID_JSON' }, { status: 400 })
  }
  const parsed = AnthropicVerifyKeySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ success: false, error: 'INVALID_BODY' }, { status: 400 })
  }
  const { orgId, apiKey } = parsed.data

  if (!/^sk-ant-/.test(apiKey)) {
    return Response.json({ success: false, error: 'INVALID_KEY' }, { status: 400 })
  }

  const result = await new AnthropicClient({ apiKey: 'mock' }).testConnection(apiKey)
  if (!result.ok) {
    return Response.json({ success: false, error: result.error ?? 'CONNECTION_FAILED' }, { status: 400 })
  }

  await storeAnthropicApiKey(orgId, apiKey)
  const db = getServiceClient()
  await db
    .update(orgsTable)
    .set({
      anthropicVaultRef: `anthropic_api_key_${orgId}`,
      anthropicConnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(orgsTable.id, orgId))

  return Response.json(
    { success: true, message: 'Claude connected', plan_detected: result.planDetected ?? null },
    { status: 200 },
  )
}

// ─── Resend guided BYOK (Sprint 9 CP4 — email delivery) ───────────────

/**
 * GET /api/resend/install?orgId=<uuid> — self-contained setup wizard.
 * Mirrors the Anthropic flow: plain HTML that POSTs the key (+ optional
 * sender email) to /api/resend/verify-key. Dashboard React flow replaces
 * this in Sprint 9-10.
 */
async function getResendInstall(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const orgId = url.searchParams.get('orgId')
  if (!orgId || !UUID_RE.test(orgId)) {
    return Response.json({ error: 'INVALID_ORG_ID', message: 'orgId (UUID) query param required' }, { status: 400 })
  }
  const db = getServiceClient()
  const [org] = await db.select({ id: orgsTable.id }).from(orgsTable).where(eq(orgsTable.id, orgId))
  if (!org) {
    return Response.json({ error: 'ORG_NOT_FOUND', message: `Org ${orgId} not found` }, { status: 404 })
  }

  const html = `<!doctype html><meta charset="utf-8"><title>Connect Resend · Spleed</title>
<style>
  body{font-family:system-ui;max-width:560px;margin:40px auto;padding:0 20px;color:#0A0A0A;line-height:1.5}
  h1{font-size:1.6rem} ol{padding-left:1.2rem} li{margin:.5rem 0}
  code{background:#FAFAF9;border:1px solid #e5e5e5;border-radius:6px;padding:1px 6px;font-size:.9em}
  input{width:100%;padding:10px;border:1px solid #d4d4d4;border-radius:8px;font-family:monospace;margin:8px 0}
  button{background:#FF6B35;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:1rem;cursor:pointer}
  #msg{margin-top:14px;font-weight:600} .ok{color:#16A34A} .err{color:#DC2626}
  .note{color:#71717A;font-size:.85rem;margin-top:18px}
</style>
<h1>Connect Resend for email</h1>
<ol>
  <li>Go to <code>resend.com</code> → API Keys → <strong>Create API Key</strong></li>
  <li>Verify your sending domain under <code>Domains</code> first (required to send)</li>
  <li>Paste the key + the verified <strong>from</strong> address below</li>
</ol>
<input id="key" type="password" placeholder="re_..." autocomplete="off" />
<input id="sender" type="email" placeholder="founder@yourdomain.com (verified sender)" autocomplete="off" />
<button onclick="verify()">Connect</button>
<div id="msg"></div>
<p class="note">Your key is encrypted in Spleed Vault and used only to send your outbound email. Sending stays paused until you flip it on.</p>
<script>
  async function verify(){
    const msg=document.getElementById('msg'); msg.textContent='Verifying…'; msg.className='';
    const apiKey=document.getElementById('key').value.trim();
    const senderEmail=document.getElementById('sender').value.trim();
    try{
      const r=await fetch('/api/resend/verify-key',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orgId:${JSON.stringify(orgId)},apiKey,senderEmail:senderEmail||undefined})});
      const d=await r.json();
      if(d.success){msg.textContent='✅ '+d.message;msg.className='ok';}
      else{msg.textContent='❌ '+(d.error||'Failed');msg.className='err';}
    }catch(e){msg.textContent='❌ Network error';msg.className='err';}
  }
</script>`
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

const ResendVerifyKeySchema = z.object({
  orgId: z.string().uuid(),
  apiKey: z.string().min(1),
  senderEmail: z.string().email().optional(),
})

/**
 * POST /api/resend/verify-key — validate + store a tenant's Resend key.
 * Mock-default testConnection accepts `re_*`; live (Sprint 9.5+) pings
 * GET /domains. On success: Vault store + orgs.resend_vault_ref/
 * resend_connected_at, and orgs.sender_email when provided (single-step
 * onboarding — the verified 'from' the Outreach Operator sends with).
 */
async function postResendVerifyKey(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ success: false, error: 'INVALID_JSON' }, { status: 400 })
  }
  const parsed = ResendVerifyKeySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ success: false, error: 'INVALID_BODY' }, { status: 400 })
  }
  const { orgId, apiKey, senderEmail } = parsed.data

  if (!/^re_/.test(apiKey)) {
    return Response.json({ success: false, error: 'INVALID_KEY' }, { status: 400 })
  }

  const result = await new ResendClient({ mockMode: true }).testConnection(apiKey)
  if (!result.ok) {
    return Response.json({ success: false, error: result.error ?? 'CONNECTION_FAILED' }, { status: 400 })
  }

  await storeResendApiKey(orgId, apiKey)
  const db = getServiceClient()
  await db
    .update(orgsTable)
    .set({
      resendVaultRef: `resend_api_key_${orgId}`,
      resendConnectedAt: new Date(),
      ...(senderEmail ? { senderEmail } : {}),
      updatedAt: new Date(),
    })
    .where(eq(orgsTable.id, orgId))

  return Response.json({ success: true, message: 'Resend connected' }, { status: 200 })
}

// ─── Bun.serve dispatch ───────────────────────────────────────────────

const SCOUT_RUN_GET_RE = /^\/api\/scout\/runs\/([^/]+)$/
const ICP_CRON_ACTIVATE_RE = /^\/api\/icps\/([^/]+)\/activate-cron$/
const ICP_CRON_PAUSE_RE = /^\/api\/icps\/([^/]+)\/pause-cron$/
const ICP_CRON_DELETE_RE = /^\/api\/icps\/([^/]+)\/cron$/
const LEAD_DOSSIER_GET_RE = /^\/api\/leads\/([^/]+)\/dossier$/
const PROFILER_RUN_LEAD_RE = /^\/api\/profiler\/run-lead\/([^/]+)$/

// Sprint 7a — export the dispatch fetch so apps/api/src/tests/ can drive
// the handlers via synthetic Request objects without binding the port.
// Bun.serve below is gated under `import.meta.main` so test imports don't
// boot a duplicate server.
export async function dispatch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'spleed-api' })
    }

    if (req.method === 'POST' && url.pathname === '/api/scout/run') {
      try {
        return await postScoutRun(req)
      } catch (err) {
        console.error('[POST /api/scout/run] internal error', err)
        return Response.json(
          { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
          { status: 500 },
        )
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/leads/ingest') {
      try {
        return await postLeadIngest(req)
      } catch (err) {
        console.error('[POST /api/leads/ingest] internal error', err)
        return Response.json(
          { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
          { status: 500 },
        )
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/slack/events') {
      try {
        return await postSlackEvents(req)
      } catch (err) {
        console.error('[POST /api/slack/events] internal error', err)
        return Response.json(
          { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
          { status: 500 },
        )
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/slack/interactions') {
      try {
        return await postSlackInteractions(req)
      } catch (err) {
        console.error('[POST /api/slack/interactions] internal error', err)
        return Response.json(
          { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
          { status: 500 },
        )
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/outreach/reply-webhook') {
      try {
        return await postOutreachReplyWebhook(req)
      } catch (err) {
        console.error('[POST /api/outreach/reply-webhook] internal error', err)
        return Response.json(
          { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
          { status: 500 },
        )
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/anthropic/verify-key') {
      try {
        return await postAnthropicVerifyKey(req)
      } catch (err) {
        console.error('[POST /api/anthropic/verify-key] internal error', err)
        return Response.json(
          { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
          { status: 500 },
        )
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/anthropic/install') {
      try {
        return await getAnthropicInstall(req)
      } catch (err) {
        console.error('[GET /api/anthropic/install] internal error', err)
        return Response.json(
          { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
          { status: 500 },
        )
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/resend/verify-key') {
      try {
        return await postResendVerifyKey(req)
      } catch (err) {
        console.error('[POST /api/resend/verify-key] internal error', err)
        return Response.json(
          { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
          { status: 500 },
        )
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/resend/install') {
      try {
        return await getResendInstall(req)
      } catch (err) {
        console.error('[GET /api/resend/install] internal error', err)
        return Response.json(
          { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
          { status: 500 },
        )
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/slack/install') {
      try {
        return await getSlackInstall(req)
      } catch (err) {
        console.error('[GET /api/slack/install] internal error', err)
        return Response.json(
          { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
          { status: 500 },
        )
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/slack/oauth/callback') {
      try {
        return await getSlackOAuthCallback(req)
      } catch (err) {
        console.error('[GET /api/slack/oauth/callback] internal error', err)
        return Response.json(
          { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
          { status: 500 },
        )
      }
    }

    if (req.method === 'POST') {
      const activate = url.pathname.match(ICP_CRON_ACTIVATE_RE)
      if (activate) {
        try {
          return await postActivateCron(req, activate[1]!)
        } catch (err) {
          console.error('[POST /api/icps/:id/activate-cron] internal error', err)
          return Response.json(
            { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
            { status: 500 },
          )
        }
      }
      const pause = url.pathname.match(ICP_CRON_PAUSE_RE)
      if (pause) {
        try {
          return await postPauseCron(req, pause[1]!)
        } catch (err) {
          console.error('[POST /api/icps/:id/pause-cron] internal error', err)
          return Response.json(
            { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
            { status: 500 },
          )
        }
      }
      const profilerRun = url.pathname.match(PROFILER_RUN_LEAD_RE)
      if (profilerRun) {
        try {
          return await postProfilerRunLead(req, profilerRun[1]!)
        } catch (err) {
          console.error('[POST /api/profiler/run-lead/:leadId] internal error', err)
          return Response.json(
            { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
            { status: 500 },
          )
        }
      }
    }

    if (req.method === 'DELETE') {
      const cronDelete = url.pathname.match(ICP_CRON_DELETE_RE)
      if (cronDelete) {
        try {
          return await deleteCron(req, cronDelete[1]!)
        } catch (err) {
          console.error('[DELETE /api/icps/:id/cron] internal error', err)
          return Response.json(
            { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
            { status: 500 },
          )
        }
      }
    }

    if (req.method === 'GET') {
      const m = url.pathname.match(SCOUT_RUN_GET_RE)
      if (m) {
        try {
          return await getScoutRun(req, m[1]!)
        } catch (err) {
          console.error('[GET /api/scout/runs/:runId] internal error', err)
          return Response.json(
            { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
            { status: 500 },
          )
        }
      }
      const dossier = url.pathname.match(LEAD_DOSSIER_GET_RE)
      if (dossier) {
        try {
          return await getLeadDossier(req, dossier[1]!)
        } catch (err) {
          console.error('[GET /api/leads/:id/dossier] internal error', err)
          return Response.json(
            { error: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown' },
            { status: 500 },
          )
        }
      }
    }

    return new Response('Spleed API', { status: 200 })
}

// Sprint 7a — only bind the port + start workers when this file is run
// directly (bun src/index.ts). Imported by tests, no side effects.
if (import.meta.main) {
  const server = Bun.serve({ port, fetch: dispatch })
  console.log(`spleed-api listening on http://localhost:${server.port}`)

  // Sprint 3: start BullMQ workers in the same process as the API server.
  // Sprint 12+ may split workers to a dedicated Railway service if scaling
  // pressure demands it. For MVP, co-location keeps ops simple.
  const running = startWorkers()
  console.log(`spleed-api started ${running.count} worker(s)`)

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received — stopping workers and server…`)
    await running.stop()
    server.stop()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
