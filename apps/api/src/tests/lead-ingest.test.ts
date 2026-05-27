/**
 * Sprint 7a — POST /api/leads/ingest integration tests.
 *
 * Drives the API dispatch handler via synthetic Request objects (no
 * port binding) and asserts both response shapes and DB state.
 *
 * Coverage (10 tests):
 *   - Default ICP lookup (org with/without/cross-org)
 *   - Happy path INSERT (lead created + Profiler enqueued)
 *   - Soft dedupe UPSERT (manual_ingest_count incremented, notes appended)
 *   - Re-trigger when status='discovered' (mode='re_enriching')
 *   - NO re-trigger when status='enriched' (mode='cached')
 *   - Default ICP applied + parked_no_icp paths
 *   - Sync mode ?wait=true success + timeout
 *   - Multi-tenant RLS isolation (cross-org separate leads)
 *
 * Sync-mode tests require REDIS_URL (BullMQ Queue connection). Skip
 * gracefully if absent — mirrors the workers.test.ts pattern.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { sql, and, eq } from 'drizzle-orm'
import {
  closeServiceClient,
  costEvents,
  getServiceClient,
  icps as icpsTable,
  leadDossiers as leadDossiersTable,
  leads as leadsTable,
  orgMembers,
  orgs,
  users,
} from '@spleed/db'
import {
  closeRedisConnection,
  createQueue,
  profilerWorker,
} from '@spleed/agents/workers'
import { dispatch } from '../index'

// ─── Constants ────────────────────────────────────────────────────────

const INGEST_ORG_A = '99999999-0000-0000-0000-000000000aaa'
const INGEST_ORG_B = '99999999-0000-0000-0000-000000000bbb'
const INGEST_USER_A = '99999999-0000-0000-0000-000000000a01'
const INGEST_USER_B = '99999999-0000-0000-0000-000000000b01'
const INGEST_USER_A_AUTH = '99999999-0000-0000-0000-000000000a02'
const INGEST_USER_B_AUTH = '99999999-0000-0000-0000-000000000b02'

const ICP_A_DEFAULT = '99999999-0000-0000-0000-000000000a10'
const ICP_A_OTHER = '99999999-0000-0000-0000-000000000a11'
const ICP_B_NONDEFAULT = '99999999-0000-0000-0000-000000000b10'

// ─── Helpers ──────────────────────────────────────────────────────────

const PROFILER_QUEUE = 'profiler'

function makeIngestRequest(
  orgId: string,
  body: Record<string, unknown>,
  search = '',
): Request {
  return new Request(`http://localhost:3001/api/leads/ingest${search}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-org-id': orgId,
    },
    body: JSON.stringify(body),
  })
}

async function clearProfilerQueue(): Promise<void> {
  const queue = createQueue(PROFILER_QUEUE)
  try {
    await queue.obliterate({ force: true })
  } catch {
    // Queue may not exist yet on first run — non-fatal.
  } finally {
    await queue.close()
  }
}

async function seedIngestFixtures(): Promise<void> {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await db.insert(orgs).values([
    { id: INGEST_ORG_A, name: 'Ingest Org A', slug: 'ingest-a' },
    { id: INGEST_ORG_B, name: 'Ingest Org B', slug: 'ingest-b' },
  ])
  await db.insert(users).values([
    { id: INGEST_USER_A, supabaseAuthId: INGEST_USER_A_AUTH, email: 'a@ingest.test', name: 'A' },
    { id: INGEST_USER_B, supabaseAuthId: INGEST_USER_B_AUTH, email: 'b@ingest.test', name: 'B' },
  ])
  await db.insert(orgMembers).values([
    { orgId: INGEST_ORG_A, userId: INGEST_USER_A, role: 'owner' },
    { orgId: INGEST_ORG_B, userId: INGEST_USER_B, role: 'owner' },
  ])
  await db.insert(icpsTable).values([
    {
      id: ICP_A_DEFAULT,
      orgId: INGEST_ORG_A,
      name: 'Org A default — SaaS founders',
      definitionNaturalLanguage: 'Technical SaaS founders.',
      parsedFilters: { version: '1', industries: ['saas'] },
      isDefault: true,
    },
    {
      id: ICP_A_OTHER,
      orgId: INGEST_ORG_A,
      name: 'Org A secondary — Fintech',
      definitionNaturalLanguage: 'Fintech CFOs.',
      parsedFilters: { version: '1', industries: ['fintech'] },
      isDefault: false,
    },
    {
      id: ICP_B_NONDEFAULT,
      orgId: INGEST_ORG_B,
      name: 'Org B non-default — Education',
      definitionNaturalLanguage: 'Education directors.',
      parsedFilters: { version: '1', industries: ['education'] },
      isDefault: false,
    },
  ])
}

async function cleanState(): Promise<void> {
  const db = getServiceClient()
  await db
    .delete(leadDossiersTable)
    .where(sql`org_id IN (${INGEST_ORG_A}::uuid, ${INGEST_ORG_B}::uuid)`)
  await db
    .delete(leadsTable)
    .where(sql`org_id IN (${INGEST_ORG_A}::uuid, ${INGEST_ORG_B}::uuid)`)
  await db
    .delete(costEvents)
    .where(sql`org_id IN (${INGEST_ORG_A}::uuid, ${INGEST_ORG_B}::uuid)`)
  await clearProfilerQueue()
}

beforeAll(async () => {
  await seedIngestFixtures()
})

afterAll(async () => {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await clearProfilerQueue()
  await closeRedisConnection()
  await closeServiceClient()
})

beforeEach(async () => {
  await cleanState()
})

// ─── 1. Default ICP resolution ────────────────────────────────────────

describe('Default ICP lookup', () => {
  it('uses Org A default when icpId omitted; explicit cross-org icpId yields 403', async () => {
    const db = getServiceClient()

    // Path A — default applied
    const reqA = makeIngestRequest(INGEST_ORG_A, {
      linkedinUrl: 'https://linkedin.com/in/icp-default-test',
    })
    const resA = await dispatch(reqA)
    expect(resA.status).toBe(201)
    const bodyA = (await resA.json()) as { leadId: string }
    const [leadA] = await db.select().from(leadsTable).where(eq(leadsTable.id, bodyA.leadId))
    expect(leadA?.icpId).toBe(ICP_A_DEFAULT)

    // Path B — explicit cross-org icpId rejected
    const reqCross = makeIngestRequest(INGEST_ORG_B, {
      linkedinUrl: 'https://linkedin.com/in/cross-org-test',
      icpId: ICP_A_DEFAULT, // Org A's ICP from an Org B caller
    })
    const resCross = await dispatch(reqCross)
    expect(resCross.status).toBe(403)
    const bodyCross = (await resCross.json()) as { error: string }
    expect(bodyCross.error).toBe('ICP_NOT_IN_ORG')

    // Path C — Org B has no default ICP, no explicit → lead.icpId=null
    const reqB = makeIngestRequest(INGEST_ORG_B, {
      linkedinUrl: 'https://linkedin.com/in/no-default-test',
    })
    const resB = await dispatch(reqB)
    expect(resB.status).toBe(201)
    const bodyB = (await resB.json()) as { leadId: string; status: string }
    expect(bodyB.status).toBe('parked_no_icp')
    const [leadB] = await db.select().from(leadsTable).where(eq(leadsTable.id, bodyB.leadId))
    expect(leadB?.icpId).toBeNull()
  })
})

// ─── 2. Happy path INSERT ─────────────────────────────────────────────

describe('POST /api/leads/ingest — happy path', () => {
  it('creates lead + enqueues Profiler with manual triggerType', async () => {
    const req = makeIngestRequest(INGEST_ORG_A, {
      linkedinUrl: 'https://linkedin.com/in/happy-path',
      companyDomain: 'happypath.io',
      name: 'Happy Path Founder',
    })
    const res = await dispatch(req)
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      leadId: string
      profilerJobId: string
      status: string
    }
    expect(body.status).toBe('queued')
    expect(body.profilerJobId).toBe(`profiler-${body.leadId}`)

    const db = getServiceClient()
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, body.leadId))
    expect(lead?.linkedinUrl).toBe('https://linkedin.com/in/happy-path')
    expect(lead?.companyDomain).toBe('happypath.io')
    expect(lead?.fullName).toBe('Happy Path Founder')
    expect(lead?.foundVia).toBe('manual_ingest')
    expect(lead?.ingestSource).toBe('manual_url')
    expect(lead?.manualIngestCount).toBe(1)
    expect(lead?.lastManualIngestAt).toBeInstanceOf(Date)

    // Profiler job present in queue.
    const queue = createQueue(PROFILER_QUEUE)
    const job = await queue.getJob(body.profilerJobId)
    expect(job).toBeDefined()
    expect(job?.data).toMatchObject({
      leadId: body.leadId,
      orgId: INGEST_ORG_A,
      triggerType: 'manual',
    })
    await queue.close()
  })
})

// ─── 3. Soft dedupe UPSERT ────────────────────────────────────────────

describe('POST /api/leads/ingest — soft dedupe UPSERT', () => {
  it('increments manual_ingest_count and appends rawSignals.manualIngestNotes', async () => {
    const url = 'https://linkedin.com/in/dedupe-test'
    const db = getServiceClient()

    // First ingest
    const res1 = await dispatch(
      makeIngestRequest(INGEST_ORG_A, { linkedinUrl: url, notes: 'first note' }),
    )
    expect(res1.status).toBe(201)
    const body1 = (await res1.json()) as { leadId: string }

    // Second ingest — same URL, new notes
    const res2 = await dispatch(
      makeIngestRequest(INGEST_ORG_A, { linkedinUrl: url, notes: 'second note' }),
    )
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as {
      leadId: string
      status: string
      manualIngestCount: number
    }
    expect(body2.leadId).toBe(body1.leadId)
    expect(body2.status).toBe('already_exists')
    expect(body2.manualIngestCount).toBe(2)

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, body1.leadId))
    expect(lead?.manualIngestCount).toBe(2)
    const raw = lead?.rawSignals as {
      manualIngestNotes?: Array<{ at: string; text: string }>
    }
    expect(raw.manualIngestNotes?.length).toBe(2)
    expect(raw.manualIngestNotes?.[0]?.text).toBe('first note')
    expect(raw.manualIngestNotes?.[1]?.text).toBe('second note')
  })
})

// ─── 4-5. Conditional re-trigger ──────────────────────────────────────

describe('POST /api/leads/ingest — conditional Profiler re-trigger', () => {
  it('re-triggers Profiler when existing lead status=discovered (mode=re_enriching)', async () => {
    const db = getServiceClient()
    const [seed] = await db
      .insert(leadsTable)
      .values({
        orgId: INGEST_ORG_A,
        icpId: ICP_A_DEFAULT,
        status: 'discovered',
        linkedinUrl: 'https://linkedin.com/in/retrigger-discovered',
        foundVia: 'manual_ingest',
        ingestSource: 'manual_url',
        manualIngestCount: 1,
      })
      .returning({ id: leadsTable.id })

    const res = await dispatch(
      makeIngestRequest(INGEST_ORG_A, {
        linkedinUrl: 'https://linkedin.com/in/retrigger-discovered',
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mode: string }
    expect(body.mode).toBe('re_enriching')

    const queue = createQueue(PROFILER_QUEUE)
    const job = await queue.getJob(`profiler-${seed!.id}`)
    expect(job).toBeDefined()
    expect(job?.data).toMatchObject({
      leadId: seed!.id,
      triggerType: 'manual_reingest',
    })
    await queue.close()
  })

  it('does NOT re-trigger when existing lead status=enriched (mode=cached)', async () => {
    const db = getServiceClient()
    const [seed] = await db
      .insert(leadsTable)
      .values({
        orgId: INGEST_ORG_A,
        icpId: ICP_A_DEFAULT,
        status: 'enriched',
        linkedinUrl: 'https://linkedin.com/in/cached-enriched',
        foundVia: 'manual_ingest',
        ingestSource: 'manual_url',
        manualIngestCount: 1,
      })
      .returning({ id: leadsTable.id })

    const res = await dispatch(
      makeIngestRequest(INGEST_ORG_A, {
        linkedinUrl: 'https://linkedin.com/in/cached-enriched',
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mode: string }
    expect(body.mode).toBe('cached')

    const queue = createQueue(PROFILER_QUEUE)
    const job = await queue.getJob(`profiler-${seed!.id}`)
    // No enqueue happened — BullMQ has no job for this leadId.
    expect(job).toBeUndefined()
    await queue.close()
  })
})

// ─── 6-7. ICP fallback paths ──────────────────────────────────────────

describe('POST /api/leads/ingest — ICP fallback', () => {
  it('applies org default ICP when payload.icpId omitted', async () => {
    const res = await dispatch(
      makeIngestRequest(INGEST_ORG_A, {
        linkedinUrl: 'https://linkedin.com/in/default-icp-applied',
      }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { leadId: string; status: string }
    expect(body.status).toBe('queued')
    const db = getServiceClient()
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, body.leadId))
    expect(lead?.icpId).toBe(ICP_A_DEFAULT)
  })

  it('parks lead with no profiler enqueue when org has no default ICP', async () => {
    const res = await dispatch(
      makeIngestRequest(INGEST_ORG_B, {
        linkedinUrl: 'https://linkedin.com/in/parked-no-icp',
      }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { leadId: string; status: string }
    expect(body.status).toBe('parked_no_icp')
    expect('profilerJobId' in body).toBe(false)

    const db = getServiceClient()
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, body.leadId))
    expect(lead?.icpId).toBeNull()
    // No profiler job for this lead.
    const queue = createQueue(PROFILER_QUEUE)
    const job = await queue.getJob(`profiler-${body.leadId}`)
    expect(job).toBeUndefined()
    await queue.close()
  })
})

// ─── 8-9. Sync mode (?wait=true) ──────────────────────────────────────

describe('POST /api/leads/ingest — sync mode ?wait=true', () => {
  it('returns 201 with dossier inline when Profiler completes in time', async () => {
    // Start the real Profiler worker so the job actually completes.
    // Mock-default clients (Sprint 6b) finish in ~100-200ms.
    const worker = profilerWorker.start()
    try {
      const req = makeIngestRequest(
        INGEST_ORG_A,
        {
          linkedinUrl: 'https://linkedin.com/in/sarahchen',
          companyDomain: 'pulseanalytics.io',
        },
        '?wait=true&timeoutMs=10000',
      )
      const res = await dispatch(req)
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        leadId: string
        status: string
        dossier: { enrichedBy: string } | null
      }
      expect(body.status).toBe('completed')
      expect(body.dossier).toBeDefined()
      // Sprint 7b bumped the worker stamp to v3 (deep research pipeline).
      expect(body.dossier?.enrichedBy).toBe('profiler_agent_v3')
    } finally {
      await worker.close()
    }
  })

  it('returns 202 Accepted on sync timeout (no worker draining the queue)', async () => {
    // No worker started. Job enqueues but stays in 'waiting'. waitForJob
    // loops until tight timeout → 202.
    const req = makeIngestRequest(
      INGEST_ORG_A,
      { linkedinUrl: 'https://linkedin.com/in/timeout-test' },
      '?wait=true&timeoutMs=1000',
    )
    const startMs = Date.now()
    const res = await dispatch(req)
    const elapsedMs = Date.now() - startMs
    expect(res.status).toBe(202)
    const body = (await res.json()) as { leadId: string; status: string }
    expect(body.status).toBe('in_progress')
    // Roughly bounded to the requested timeout (allow generous slack for
    // poll-interval rounding).
    expect(elapsedMs).toBeGreaterThanOrEqual(900)
    expect(elapsedMs).toBeLessThan(3000)
  })
})

// ─── 10. Multi-tenant RLS isolation ───────────────────────────────────

describe('POST /api/leads/ingest — multi-tenant isolation', () => {
  it('same linkedinUrl across orgs produces separate leads; cross-org dossier GET is 404', async () => {
    const url = 'https://linkedin.com/in/cross-tenant'

    const resA = await dispatch(makeIngestRequest(INGEST_ORG_A, { linkedinUrl: url }))
    expect(resA.status).toBe(201)
    const bodyA = (await resA.json()) as { leadId: string }

    const resB = await dispatch(
      makeIngestRequest(INGEST_ORG_B, { linkedinUrl: url, icpId: ICP_B_NONDEFAULT }),
    )
    expect(resB.status).toBe(201)
    const bodyB = (await resB.json()) as { leadId: string }

    // Different lead rows — soft dedupe is scoped per-org.
    expect(bodyA.leadId).not.toBe(bodyB.leadId)
    const db = getServiceClient()
    const [leadA] = await db.select().from(leadsTable).where(eq(leadsTable.id, bodyA.leadId))
    const [leadB] = await db.select().from(leadsTable).where(eq(leadsTable.id, bodyB.leadId))
    expect(leadA?.orgId).toBe(INGEST_ORG_A)
    expect(leadB?.orgId).toBe(INGEST_ORG_B)

    // Org B cannot read Org A's dossier via GET /api/leads/:id/dossier
    // (404, not 403 — the API masks existence to prevent enumeration).
    const dossierReq = new Request(`http://localhost:3001/api/leads/${bodyA.leadId}/dossier`, {
      method: 'GET',
      headers: { 'x-org-id': INGEST_ORG_B },
    })
    const dossierRes = await dispatch(dossierReq)
    expect(dossierRes.status).toBe(404)
  })
})
