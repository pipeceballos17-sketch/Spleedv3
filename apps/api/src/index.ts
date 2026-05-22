import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  getServiceClient,
  icps as icpsTable,
  leadDossiers as leadDossiersTable,
  leads as leadsTable,
  scoutRuns,
} from '@spleed/db'
import {
  profilerWorker,
  scoutWorker,
  registerScoutCronForOrg,
  unregisterScoutCronForOrg,
  pauseScoutCron,
  getScoutCron,
} from '@spleed/agents/workers'
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

// ─── Bun.serve dispatch ───────────────────────────────────────────────

const SCOUT_RUN_GET_RE = /^\/api\/scout\/runs\/([^/]+)$/
const ICP_CRON_ACTIVATE_RE = /^\/api\/icps\/([^/]+)\/activate-cron$/
const ICP_CRON_PAUSE_RE = /^\/api\/icps\/([^/]+)\/pause-cron$/
const ICP_CRON_DELETE_RE = /^\/api\/icps\/([^/]+)\/cron$/
const LEAD_DOSSIER_GET_RE = /^\/api\/leads\/([^/]+)\/dossier$/
const PROFILER_RUN_LEAD_RE = /^\/api\/profiler\/run-lead\/([^/]+)$/

const server = Bun.serve({
  port,
  async fetch(req) {
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
  },
})

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
