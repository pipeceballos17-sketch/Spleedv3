import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  getServiceClient,
  icps as icpsTable,
  leadDossiers as leadDossiersTable,
  leads as leadsTable,
  orgs as orgsTable,
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
  waitForJob,
} from '@spleed/agents/workers'
import {
  SlackClient,
  storeSlackOAuthTokens,
  verifySlackSignature,
  type SlackEventEnvelope,
  type SlackMessageImEvent,
} from '@spleed/integrations/slack'
import { signOAuthState, verifyOAuthState } from './helpers/slack-oauth-state'
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
