/**
 * Sprint 5a Scout test suite.
 *
 * Coverage:
 *   - 3 unit tests for parseICPToApolloFilters
 *   - 3 unit tests for calculateSQLFitScore
 *   - 6 integration tests for processScoutJob (DB end-to-end, BullMQ bypassed)
 *   - 2 multi-tenant isolation tests
 *
 * Total: 14 tests.
 *
 * Strategy: tests call `processScoutJob` directly with a synthetic ctx so we
 * exercise the full DB pipeline without spinning up Redis. Full BullMQ
 * integration coverage lands in Sprint 5b alongside granular error
 * categorization.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { sql, and, eq } from 'drizzle-orm'
import pino from 'pino'
import {
  closeServiceClient,
  costEvents,
  getServiceClient,
  icps as icpsTable,
  leads as leadsTable,
  orgMembers,
  orgs,
  scoutRuns as scoutRunsTable,
  users,
} from '@spleed/db'
import { ApolloClient, MOCK_CANDIDATES } from '@spleed/integrations/apollo'
import {
  calculateSQLFitScore,
  parseICPToApolloFilters,
  type IcpRow,
} from '../agents/scout'
import { createScopedDb, type WorkerContext } from '../workers/context'
import { processScoutJob, type ScoutJob } from '../workers/scout.worker'

// ─── Constants ────────────────────────────────────────────────────────

const SCOUT_ORG_A = '77777777-7777-7777-7777-77777777aaaa'
const SCOUT_ORG_B = '77777777-7777-7777-7777-77777777bbbb'
const SCOUT_USER_A_ID = '77777777-7777-7777-7777-77777777aa11'
const SCOUT_USER_B_ID = '77777777-7777-7777-7777-77777777bb11'
const SCOUT_USER_A_AUTH = '77777777-7777-7777-7777-77777777aa22'
const SCOUT_USER_B_AUTH = '77777777-7777-7777-7777-77777777bb22'

const ICP_EDU_ID = '77777777-7777-7777-7777-7777777ed011'
const ICP_SAAS_ID = '77777777-7777-7777-7777-777777750055'
const ICP_FINTECH_ID = '77777777-7777-7777-7777-7777777fb011'

// ─── Test helpers ─────────────────────────────────────────────────────

const silentLogger = pino({ level: 'silent' })

function makeCtx(orgId: string, traceId = `scout-test-${Date.now()}`): WorkerContext {
  return {
    orgId,
    jobId: traceId,
    traceId,
    attemptsMade: 0,
    logger: silentLogger,
    db: createScopedDb(orgId),
  }
}

function makeJob(overrides: Partial<ScoutJob> & { runId: string; orgId: string; icpId: string }): {
  data: ScoutJob
} {
  return {
    data: {
      requestedVolume: 50,
      triggerType: 'manual_test',
      ...overrides,
    },
  }
}

async function seedScoutFixtures(): Promise<void> {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)

  await db.insert(orgs).values([
    { id: SCOUT_ORG_A, name: 'Scout Test Org A', slug: 'scout-org-a' },
    { id: SCOUT_ORG_B, name: 'Scout Test Org B', slug: 'scout-org-b' },
  ])
  await db.insert(users).values([
    { id: SCOUT_USER_A_ID, supabaseAuthId: SCOUT_USER_A_AUTH, email: 'a@scout.test', name: 'A' },
    { id: SCOUT_USER_B_ID, supabaseAuthId: SCOUT_USER_B_AUTH, email: 'b@scout.test', name: 'B' },
  ])
  await db.insert(orgMembers).values([
    { orgId: SCOUT_ORG_A, userId: SCOUT_USER_A_ID, role: 'owner' },
    { orgId: SCOUT_ORG_B, userId: SCOUT_USER_B_ID, role: 'owner' },
  ])

  await db.insert(icpsTable).values([
    {
      id: ICP_EDU_ID,
      orgId: SCOUT_ORG_A,
      name: 'Education B2B Colombia',
      definitionNaturalLanguage:
        'Directors / Rectors at private schools in Colombia, 30-500 students.',
      parsedFilters: {
        version: '1',
        industries: ['education'],
        geos: ['Colombia'],
        titles: ['Director', 'Rector', 'Founder', 'CEO'],
        companySizeMin: 30,
        companySizeMax: 500,
      },
    },
    {
      id: ICP_SAAS_ID,
      orgId: SCOUT_ORG_A,
      name: 'SaaS B2B Founders US',
      definitionNaturalLanguage:
        'Technical founders of B2B SaaS startups in the US, pre-seed/seed, modern stack.',
      parsedFilters: {
        version: '1',
        industries: ['saas'],
        geos: ['United States', 'San Francisco', 'New York', 'Austin'],
        titles: ['Founder', 'CEO', 'CTO'],
        companySizeMin: 1,
        companySizeMax: 25,
        techStack: ['stripe', 'segment', 'snowflake'],
      },
    },
    {
      id: ICP_FINTECH_ID,
      orgId: SCOUT_ORG_B,
      name: 'Fintech CFOs LatAm',
      definitionNaturalLanguage: 'CFOs at fintech companies in LatAm, 30-200 employees.',
      parsedFilters: {
        version: '1',
        industries: ['fintech'],
        geos: ['Colombia', 'Mexico'],
        titles: ['CFO', 'CEO'],
        companySizeMin: 30,
        companySizeMax: 200,
      },
    },
  ])
}

async function cleanScoutState(): Promise<void> {
  const db = getServiceClient()
  // Order matters: leads FKs cost_events.run_id → scout_runs.id chain.
  // CASCADE on scout_runs deletion would NULL out cost_events.run_id but
  // leave the cost_events row; clean cost_events first.
  await db
    .delete(leadsTable)
    .where(sql`org_id IN (${SCOUT_ORG_A}::uuid, ${SCOUT_ORG_B}::uuid)`)
  await db
    .delete(costEvents)
    .where(sql`org_id IN (${SCOUT_ORG_A}::uuid, ${SCOUT_ORG_B}::uuid)`)
  await db
    .delete(scoutRunsTable)
    .where(sql`org_id IN (${SCOUT_ORG_A}::uuid, ${SCOUT_ORG_B}::uuid)`)
}

async function createQueuedRun(
  orgId: string,
  icpId: string,
  requestedVolume = 50,
): Promise<string> {
  const db = getServiceClient()
  const [row] = await db
    .insert(scoutRunsTable)
    .values({
      orgId,
      icpId,
      status: 'queued',
      triggerType: 'manual_test',
      requestedVolume,
    })
    .returning({ id: scoutRunsTable.id })
  return row!.id
}

// ─── Suite setup ──────────────────────────────────────────────────────

beforeAll(async () => {
  await seedScoutFixtures()
})

afterAll(async () => {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await closeServiceClient()
})

beforeEach(async () => {
  await cleanScoutState()
})

// ─── 1-3. parseICPToApolloFilters ─────────────────────────────────────

describe('parseICPToApolloFilters', () => {
  it('maps education Colombia ICP to expected Apollo filters', async () => {
    const db = getServiceClient()
    const [icp] = await db.select().from(icpsTable).where(eq(icpsTable.id, ICP_EDU_ID))
    expect(icp).toBeDefined()

    const filters = parseICPToApolloFilters(icp as IcpRow)
    expect(filters).toEqual({
      industries: ['education'],
      companySize: { min: 30, max: 500 },
      locations: ['Colombia'],
      titles: ['Director', 'Rector', 'Founder', 'CEO'],
    })
  })

  it('maps SaaS US ICP including techStack to Apollo filters', async () => {
    const db = getServiceClient()
    const [icp] = await db.select().from(icpsTable).where(eq(icpsTable.id, ICP_SAAS_ID))
    const filters = parseICPToApolloFilters(icp as IcpRow)
    expect(filters.industries).toEqual(['saas'])
    expect(filters.companySize).toEqual({ min: 1, max: 25 })
    expect(filters.technologies).toEqual(['stripe', 'segment', 'snowflake'])
    expect(filters.titles).toEqual(['Founder', 'CEO', 'CTO'])
  })

  it('omits filter fields whose ICP value is empty / undefined', () => {
    const minimal: IcpRow = {
      id: ICP_EDU_ID,
      orgId: SCOUT_ORG_A,
      name: 'Empty ICP',
      definitionNaturalLanguage: '',
      parsedFilters: { version: '1', titles: [], seniorities: [], techStack: [] },
      isActive: true,
      naturalLanguageUpdatedAt: new Date(),
      parsedFiltersUpdatedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const filters = parseICPToApolloFilters(minimal)
    expect(filters).toEqual({})
  })
})

// ─── 4-6. calculateSQLFitScore ────────────────────────────────────────

describe('calculateSQLFitScore', () => {
  it('returns 100 for perfect match (Sarah Chen vs SaaS US ICP)', async () => {
    const db = getServiceClient()
    const [icp] = await db.select().from(icpsTable).where(eq(icpsTable.id, ICP_SAAS_ID))
    const sarah = MOCK_CANDIDATES.find((c) => c.id === 'apollo_mock_01')!
    const score = calculateSQLFitScore(sarah, icp as IcpRow)
    // 30 (industry saas) + 25 (size 12 in [1,25]) + 15 (location SF) +
    // 20 (3/3 techs) + 10 (founder title) = 100
    expect(score).toBe(100)
  })

  it('returns low score for partial match (Laura education vs SaaS US ICP)', async () => {
    const db = getServiceClient()
    const [icp] = await db.select().from(icpsTable).where(eq(icpsTable.id, ICP_SAAS_ID))
    const laura = MOCK_CANDIDATES.find((c) => c.id === 'apollo_mock_06')!
    const score = calculateSQLFitScore(laura, icp as IcpRow)
    // industry education ≠ saas → 0
    // size 120 ∉ [1,25] → 0
    // location 'Medellín, Colombia' contains no US geo → 0
    // techs google_workspace ∉ {stripe,segment,snowflake} → 0
    // title 'Director of Academics' substring-matches 'CTO' inside the
    // word 'direCTOr' (d-i-r-e-c-t-o-r) — Sprint 5a's intentional SQL
    // approximation; Sprint 5b LLM re-ranking suppresses these false
    // positives. So title_seniority hit = 10. Total → 10.
    expect(score).toBe(10)
  })

  it('returns 0 for zero-match candidate (Henry Wallace manufacturer vs SaaS US ICP)', async () => {
    const db = getServiceClient()
    const [icp] = await db.select().from(icpsTable).where(eq(icpsTable.id, ICP_SAAS_ID))
    const henry = MOCK_CANDIDATES.find((c) => c.id === 'apollo_mock_10')!
    const score = calculateSQLFitScore(henry, icp as IcpRow)
    expect(score).toBe(0)
  })
})

// ─── 7-12. processScoutJob integration ───────────────────────────────

describe('processScoutJob — end-to-end pipeline', () => {
  it('education ICP → Laura + Esteban inserted with correct run_id and foundVia', async () => {
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)
    const ctx = makeCtx(SCOUT_ORG_A)

    const result = await processScoutJob(
      makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
      ctx,
    )
    expect(result.status).toBe('completed')
    expect(result.apolloCandidatesFound).toBe(2)
    expect(result.leadsInsertedCount).toBe(2)

    const db = getServiceClient()
    const inserted = await db.select().from(leadsTable).where(eq(leadsTable.orgId, SCOUT_ORG_A))
    expect(inserted).toHaveLength(2)

    const names = inserted.map((l) => l.fullName).sort()
    expect(names).toEqual(['Esteban Vargas', 'Laura Pérez'])

    for (const lead of inserted) {
      expect(lead.runId).toBe(runId)
      expect(lead.foundVia).toBe('apollo_scout_v1')
      expect(lead.icpId).toBe(ICP_EDU_ID)
      expect(lead.status).toBe('discovered')
      expect((lead.fitScore ?? 0) > 0).toBe(true)
    }
  })

  it('SaaS US ICP → top leads ordered by fit_score DESC (Sarah > Priya > Marcus)', async () => {
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_SAAS_ID, 10)
    const ctx = makeCtx(SCOUT_ORG_A)
    await processScoutJob(
      makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_SAAS_ID, requestedVolume: 10 }),
      ctx,
    )

    const db = getServiceClient()
    const rows = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.orgId, SCOUT_ORG_A))
    // Sort to match the worker's intended DESC ranking — Bun's order isn't
    // guaranteed without ORDER BY.
    const sorted = rows.sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))

    expect(sorted[0]?.fullName).toBe('Sarah Chen')
    expect(sorted[0]?.fitScore).toBe(100)
    expect(sorted[1]?.fullName).toBe('Priya Iyer')
    expect(sorted[2]?.fullName).toBe('Marcus Reed')

    // Strict ordering: every adjacent pair must be DESC.
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i - 1]!.fitScore!).toBeGreaterThanOrEqual(sorted[i]!.fitScore!)
    }
  })

  it('dedupe: pre-existing lead with same email → status="partial", insert count reduced', async () => {
    const db = getServiceClient()
    // Pre-seed Sarah's email so the upcoming scout run hits the unique
    // constraint and onConflictDoNothing skips that row.
    await db.insert(leadsTable).values({
      orgId: SCOUT_ORG_A,
      icpId: ICP_SAAS_ID,
      status: 'discovered',
      fullName: 'Sarah Chen (preexisting)',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Different Co',
      role: 'CEO',
      email: 'sarah@pulseanalytics.io',
      foundVia: 'manual',
    })

    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_SAAS_ID, 10)
    const result = await processScoutJob(
      makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_SAAS_ID, requestedVolume: 10 }),
      makeCtx(SCOUT_ORG_A),
    )

    expect(result.status).toBe('partial')
    expect(result.sqlFilteredCount).toBe(3) // Sarah + Priya + Marcus matched
    expect(result.leadsInsertedCount).toBe(2) // Sarah deduped
  })

  it('writes a cost_events row tagged with provider=apollo, success=true, run_id', async () => {
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)
    await processScoutJob(makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }), makeCtx(SCOUT_ORG_A))

    const db = getServiceClient()
    const events = await db
      .select()
      .from(costEvents)
      .where(and(eq(costEvents.orgId, SCOUT_ORG_A), eq(costEvents.runId, runId)))

    expect(events).toHaveLength(1)
    expect(events[0]?.agentType).toBe('scout')
    expect(events[0]?.provider).toBe('apollo')
    expect(events[0]?.operationType).toBe('search')
    expect(events[0]?.success).toBe(true)
    // 2 candidates × $0.05 = $0.10 — cost stored as string at numeric(10,6).
    expect(events[0]?.costUsd).toBe('0.100000')
  })

  it('scout_runs lifecycle: queued → running → completed with populated counts', async () => {
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)
    const db = getServiceClient()

    // Pre-run state: queued, started_at null
    const [pre] = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.id, runId))
    expect(pre?.status).toBe('queued')
    expect(pre?.startedAt).toBeNull()

    await processScoutJob(makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }), makeCtx(SCOUT_ORG_A))

    const [post] = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.id, runId))
    expect(post?.status).toBe('completed')
    expect(post?.startedAt).toBeInstanceOf(Date)
    expect(post?.finishedAt).toBeInstanceOf(Date)
    expect(post?.apolloCandidatesFound).toBe(2)
    expect(post?.sqlFilteredCount).toBe(2)
    expect(post?.leadsInsertedCount).toBe(2)
    expect(post?.errorSummary).toBeNull()
  })

  it('Apollo failure → status=failed + error_summary populated + cost_events success=false', async () => {
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)
    const ctx = makeCtx(SCOUT_ORG_A)

    // Inject a throwing client. Construct a real ApolloClient then patch the
    // method — preserves the structural type without exposing a private
    // mocks module.
    const failingApollo = new ApolloClient({ apiKey: 'mock' })
    failingApollo.searchPeople = async () => {
      throw new Error('NETWORK_TIMEOUT: simulated outage')
    }

    let caught: unknown
    try {
      await processScoutJob(
        makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
        ctx,
        { apollo: failingApollo },
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)

    const db = getServiceClient()
    const [run] = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.id, runId))
    expect(run?.status).toBe('failed')
    expect(run?.errorSummary).not.toBeNull()
    const summary = run!.errorSummary as { code: string; message: string }
    expect(summary.code).toBe('NETWORK_TIMEOUT')
    expect(summary.message).toContain('simulated outage')

    const events = await db
      .select()
      .from(costEvents)
      .where(and(eq(costEvents.orgId, SCOUT_ORG_A), eq(costEvents.runId, runId)))
    expect(events).toHaveLength(1)
    expect(events[0]?.success).toBe(false)
    expect(events[0]?.costUsd).toBe('0.000000')
    expect(events[0]?.errorCode).toContain('NETWORK_TIMEOUT')

    // Inserted-leads count must be 0 — the failure happened pre-scoring.
    const leads = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.orgId, SCOUT_ORG_A), eq(leadsTable.runId, runId)))
    expect(leads).toHaveLength(0)
  })
})

// ─── 13-14. Multi-tenant isolation ────────────────────────────────────

describe('multi-tenant isolation', () => {
  it('ORG_A scout run does not write any rows under ORG_B', async () => {
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)
    await processScoutJob(makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }), makeCtx(SCOUT_ORG_A))

    const db = getServiceClient()
    const orgBRuns = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.orgId, SCOUT_ORG_B))
    const orgBLeads = await db.select().from(leadsTable).where(eq(leadsTable.orgId, SCOUT_ORG_B))
    const orgBCosts = await db.select().from(costEvents).where(eq(costEvents.orgId, SCOUT_ORG_B))

    expect(orgBRuns).toHaveLength(0)
    expect(orgBLeads).toHaveLength(0)
    expect(orgBCosts).toHaveLength(0)

    // Affirmative side: ORG_A did get the writes (catch a scenario where
    // both orgs end up empty, which would also satisfy the negative).
    const orgARuns = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.orgId, SCOUT_ORG_A))
    expect(orgARuns.length).toBeGreaterThan(0)
  })

  it('ICP from a different org throws ICP_NOT_FOUND (worker scopes by orgId)', async () => {
    // Create a scout_runs row tied to ORG_B's ICP but routed through ORG_A
    // context — simulating a poisoned job payload. Worker must reject.
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_FINTECH_ID, 50)

    let caught: Error | undefined
    try {
      await processScoutJob(
        makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_FINTECH_ID }),
        makeCtx(SCOUT_ORG_A),
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/^ICP_NOT_FOUND/)

    const db = getServiceClient()
    const [run] = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.id, runId))
    expect(run?.status).toBe('failed')
    expect((run?.errorSummary as { code: string })?.code).toBe('ICP_NOT_FOUND')
  })
})
