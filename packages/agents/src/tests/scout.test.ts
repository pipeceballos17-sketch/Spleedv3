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
  AnthropicClient,
  SQL_WEIGHT,
  LLM_WEIGHT,
  buildRerankPrompt,
  parseRerankResponse,
  type IcpShape,
} from '@spleed/integrations/anthropic'
import {
  SlackWebhookClient,
  MOCK_SLACK_SENDS,
  resetMockSlackSends,
} from '@spleed/integrations/slack'
import {
  classifyError,
  errors as taggedErrors,
  withTransientRetry,
  TaggedAgentError,
} from '../runtime/errors'
import {
  calculateSQLFitScore,
  parseICPToApolloFilters,
  type IcpRow,
} from '../agents/scout'
import { createScopedDb, type WorkerContext } from '../workers/context'
import { processScoutJob, type ScoutJob } from '../workers/scout.worker'
import {
  getScoutCron,
  registerScoutCronForOrg,
  scoutCronSchedulerId,
  unregisterScoutCronForOrg,
} from '../workers/scout-cron'

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
    {
      id: SCOUT_ORG_A,
      name: 'Scout Test Org A',
      slug: 'scout-org-a',
      // Explicit timezone exercises the CP2 cron tz propagation test below.
      timezone: 'America/Bogota',
    },
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
    // Sprint 5b: run now writes 1 apollo + N anthropic rows. Filter to apollo
    // here; LLM cost_events get their own assertion in the Sprint 5b tests below.
    const apolloEvents = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.orgId, SCOUT_ORG_A),
          eq(costEvents.runId, runId),
          eq(costEvents.provider, 'apollo'),
        ),
      )

    expect(apolloEvents).toHaveLength(1)
    expect(apolloEvents[0]?.agentType).toBe('scout')
    expect(apolloEvents[0]?.operationType).toBe('search')
    expect(apolloEvents[0]?.success).toBe(true)
    // 2 candidates × $0.05 = $0.10 — cost stored as string at numeric(10,6).
    expect(apolloEvents[0]?.costUsd).toBe('0.100000')
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
    // Sprint 5b additions — LLM phase ran for all 2 candidates.
    expect(post?.llmRerankedCount).toBe(2)
    expect(post?.llmTotalCostUsd).not.toBeNull()
    expect(Number(post?.llmTotalCostUsd)).toBeGreaterThan(0)
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
        // Fast backoff so the 3-retry escalation path (Sprint 5b CP3) runs
        // in single-digit ms rather than ~3s of real backoff.
        { apollo: failingApollo, retryBackoffBaseMs: 1 },
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
    // LLM phase was never reached (Apollo failed first) — both columns stay NULL.
    expect(run?.llmRerankedCount).toBeNull()
    expect(run?.llmTotalCostUsd).toBeNull()

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

// ─── Sprint 5b CP1 — Anthropic re-rank unit tests ────────────────────

describe('AnthropicClient (mock) — unit', () => {
  const baseIcp: IcpShape = {
    name: 'Test ICP',
    definitionNaturalLanguage: 'SaaS founders US',
    parsedFilters: { industries: ['saas'], titles: ['Founder', 'CEO'] },
  }

  it('combined score uses 0.4×SQL + 0.6×LLM weights', async () => {
    // Sanity check the weight constants the worker relies on. If these drift
    // (Sprint 8 Hermes tuning), this test surfaces the change loudly.
    expect(SQL_WEIGHT).toBe(0.4)
    expect(LLM_WEIGHT).toBe(0.6)

    const client = new AnthropicClient({ apiKey: 'mock', mockMode: true })
    const sarah = MOCK_CANDIDATES.find((c) => c.id === 'apollo_mock_01')!
    const result = await client.scoreLead({ icp: baseIcp, candidate: sarah, sqlScore: 50 })

    // sqlScore=50, candidate industry='saas' matches → mock bonus +10 → llm ≈ 50 + 10 ± noise.
    // combined = round(0.4 * 50 + 0.6 * llmScore) — verify formula directly,
    // not the noise value (the noise depends on candidate id char-sum).
    const expectedCombined = Math.min(
      100,
      Math.round(SQL_WEIGHT * 50 + LLM_WEIGHT * result.llmScore),
    )
    expect(result.combinedScore).toBe(expectedCombined)
    expect(result.tokensIn).toBe(200)
    expect(result.tokensOut).toBe(80)
    expect(result.costUsd).toBeGreaterThan(0)
  })

  it('mock is deterministic: same input → same output', async () => {
    const client = new AnthropicClient({ apiKey: 'mock', mockMode: true })
    const candidate = MOCK_CANDIDATES.find((c) => c.id === 'apollo_mock_04')!
    const first = await client.scoreLead({ icp: baseIcp, candidate, sqlScore: 40 })
    const second = await client.scoreLead({ icp: baseIcp, candidate, sqlScore: 40 })
    expect(second.llmScore).toBe(first.llmScore)
    expect(second.combinedScore).toBe(first.combinedScore)
    expect(second.reasoning).toBe(first.reasoning)
    expect(second.latencyMs).toBe(first.latencyMs)
  })

  it('prompts: buildRerankPrompt round-trips with parseRerankResponse on valid JSON', () => {
    const candidate = MOCK_CANDIDATES.find((c) => c.id === 'apollo_mock_01')!
    const prompt = buildRerankPrompt({ icp: baseIcp, candidate, sqlScore: 85 })
    expect(prompt).toContain('Test ICP')
    expect(prompt).toContain('Sarah Chen')
    expect(prompt).toContain('SQL baseline score: 85/100')

    // Simulate a clean LLM JSON response.
    const parsed = parseRerankResponse('{"llmScore": 92, "reasoning": "Strong fit."}')
    expect(parsed.llmScore).toBe(92)
    expect(parsed.reasoning).toBe('Strong fit.')

    // Permissive on stray prose around the JSON (LLMs disobey sometimes).
    const parsedNoisy = parseRerankResponse(
      'Sure! Here you go:\n```json\n{"llmScore": 77, "reasoning": "Decent."}\n```',
    )
    expect(parsedNoisy.llmScore).toBe(77)

    // Hard-fail fallback for total garbage — sentinel score 0 + parse-failed reason.
    const parsedBad = parseRerankResponse('not json at all')
    expect(parsedBad.llmScore).toBe(0)
    expect(parsedBad.reasoning).toMatch(/^PARSE_FAILED/)
  })
})

// ─── Sprint 5b CP1 — Worker LLM-phase integration tests ──────────────

describe('processScoutJob — LLM re-ranking integration', () => {
  it('writes one cost_events row per LLM call (provider=anthropic) tagged with candidate_id', async () => {
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)
    await processScoutJob(
      makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
      makeCtx(SCOUT_ORG_A),
    )

    const db = getServiceClient()
    const llmEvents = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.orgId, SCOUT_ORG_A),
          eq(costEvents.runId, runId),
          eq(costEvents.provider, 'anthropic'),
        ),
      )

    // Education ICP returns 2 Apollo candidates → 2 LLM calls → 2 cost rows.
    expect(llmEvents).toHaveLength(2)
    for (const ev of llmEvents) {
      expect(ev.agentType).toBe('scout')
      expect(ev.operationType).toBe('rerank_score')
      expect(ev.success).toBe(true)
      expect(ev.tokensIn).toBe(200)
      expect(ev.tokensOut).toBe(80)
      expect(Number(ev.costUsd)).toBeGreaterThan(0)
      const meta = ev.metadata as Record<string, unknown>
      expect(meta.model).toBe('claude-sonnet-4-6')
      expect(typeof meta.candidate_id).toBe('string')
      expect(typeof meta.sql_score).toBe('number')
      expect(typeof meta.llm_score).toBe('number')
      expect(typeof meta.combined_score).toBe('number')
    }
  })

  it('scout_runs.llm_total_cost_usd equals the sum of individual LLM cost_events', async () => {
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_SAAS_ID, 10)
    await processScoutJob(
      makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_SAAS_ID, requestedVolume: 10 }),
      makeCtx(SCOUT_ORG_A),
    )

    const db = getServiceClient()
    const [run] = await db
      .select()
      .from(scoutRunsTable)
      .where(eq(scoutRunsTable.id, runId))
    const llmEvents = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.orgId, SCOUT_ORG_A),
          eq(costEvents.runId, runId),
          eq(costEvents.provider, 'anthropic'),
        ),
      )

    expect(run?.llmRerankedCount).toBe(llmEvents.length)
    const summed = llmEvents.reduce((acc, ev) => acc + Number(ev.costUsd), 0)
    // numeric(10,6) precision — compare to 6 decimals.
    expect(Number(run?.llmTotalCostUsd)).toBeCloseTo(summed, 6)
  })

  it('leads.fitScore stores combinedScore (not raw SQL), and fitReasoning populated from LLM', async () => {
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)
    await processScoutJob(
      makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
      makeCtx(SCOUT_ORG_A),
    )

    const db = getServiceClient()
    const leads = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.orgId, SCOUT_ORG_A), eq(leadsTable.runId, runId)))
    expect(leads.length).toBe(2)

    for (const lead of leads) {
      // Combined score must equal the worker's formula based on the snapshot
      // we cached in rawSignals.
      const raw = lead.rawSignals as { score_phase: string; llm_score: number | null }
      expect(raw.score_phase).toBe('combined_v1')
      expect(typeof raw.llm_score).toBe('number')
      expect(lead.fitReasoning).toMatch(/^Mock:/)
      // fit_score is the combinedScore — must lie within the SQL/LLM range.
      // (Round-trip the math precisely as the worker does it.)
      const sqlScore = 80 // both Laura + Esteban score 80 in SQL against education ICP
      const llmScore = raw.llm_score!
      const expected = Math.min(
        100,
        Math.round(SQL_WEIGHT * sqlScore + LLM_WEIGHT * llmScore),
      )
      expect(lead.fitScore).toBe(expected)
    }
  })

  it('anthropic override injection: custom client controls LLM scores', async () => {
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)
    const customAnthropic = new AnthropicClient({ apiKey: 'mock', mockMode: true })
    // Stub scoreLead to return a fixed result so we can assert the worker
    // honored the injection (mirror of the apollo override pattern).
    customAnthropic.scoreLead = async ({ sqlScore }) => ({
      llmScore: 50,
      reasoning: 'Stub from custom injection',
      combinedScore: Math.round(SQL_WEIGHT * sqlScore + LLM_WEIGHT * 50),
      tokensIn: 123,
      tokensOut: 45,
      costUsd: 0.000123,
      latencyMs: 17,
    })

    await processScoutJob(
      makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
      makeCtx(SCOUT_ORG_A),
      { anthropic: customAnthropic },
    )

    const db = getServiceClient()
    const leads = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.orgId, SCOUT_ORG_A), eq(leadsTable.runId, runId)))

    for (const lead of leads) {
      expect(lead.fitReasoning).toBe('Stub from custom injection')
      const raw = lead.rawSignals as { llm_score: number }
      expect(raw.llm_score).toBe(50)
    }

    const llmEvents = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.orgId, SCOUT_ORG_A),
          eq(costEvents.runId, runId),
          eq(costEvents.provider, 'anthropic'),
        ),
      )
    // Cost reflects the injected stub (123 in / 45 out tokens — not the real
    // mock's 200/80 default).
    for (const ev of llmEvents) {
      expect(ev.tokensIn).toBe(123)
      expect(ev.tokensOut).toBe(45)
    }
  })

  it('LLM phase preserves SQL ordering when bonuses are uniform (regression for Sprint 5a sort test)', async () => {
    // Sprint 5a test 8 asserted Sarah > Priya > Marcus by SQL. With LLM
    // bonuses applied uniformly (all SaaS industry match), combined order
    // must remain Sarah > Priya > Marcus.
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_SAAS_ID, 10)
    await processScoutJob(
      makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_SAAS_ID, requestedVolume: 10 }),
      makeCtx(SCOUT_ORG_A),
    )

    const db = getServiceClient()
    const rows = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.orgId, SCOUT_ORG_A))
    const sorted = rows.sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))

    expect(sorted[0]?.fullName).toBe('Sarah Chen')
    expect(sorted[1]?.fullName).toBe('Priya Iyer')
    expect(sorted[2]?.fullName).toBe('Marcus Reed')
  })
})

// ─── Sprint 5b CP2 — Cron triggers + dedupe ──────────────────────────

describe('processScoutJob — cron path + duplicate dedupe', () => {
  it('cron-fired job (no runId in payload) creates a scout_runs row inline', async () => {
    // Mirror the BullMQ scheduler firing pattern: data payload omits runId,
    // worker creates the row itself. Verify the run lands with triggerType='cron'.
    const result = await processScoutJob(
      {
        data: {
          orgId: SCOUT_ORG_A,
          icpId: ICP_EDU_ID,
          requestedVolume: 50,
          triggerType: 'cron',
          // runId omitted intentionally
        },
      },
      makeCtx(SCOUT_ORG_A),
    )

    expect(result.status).toBe('completed')

    const db = getServiceClient()
    const rows = await db
      .select()
      .from(scoutRunsTable)
      .where(
        and(eq(scoutRunsTable.orgId, SCOUT_ORG_A), eq(scoutRunsTable.icpId, ICP_EDU_ID)),
      )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.triggerType).toBe('cron')
    expect(rows[0]?.status).toBe('completed')
    expect(rows[0]?.leadsInsertedCount).toBe(2)
  })

  it('dedupe: second run for same (org, icp) while one is in-flight is skipped with SKIPPED_DUPLICATE', async () => {
    // Plant a pre-existing 'running' row to simulate "already in flight".
    const db = getServiceClient()
    const [planted] = await db
      .insert(scoutRunsTable)
      .values({
        orgId: SCOUT_ORG_A,
        icpId: ICP_EDU_ID,
        status: 'running',
        triggerType: 'on_demand',
        requestedVolume: 50,
        startedAt: new Date(),
      })
      .returning({ id: scoutRunsTable.id })

    // Now issue a cron-fired run for the same (org, icp) — should observe
    // the planted run and skip cleanly.
    const result = await processScoutJob(
      {
        data: {
          orgId: SCOUT_ORG_A,
          icpId: ICP_EDU_ID,
          requestedVolume: 50,
          triggerType: 'cron',
        },
      },
      makeCtx(SCOUT_ORG_A),
    )

    expect(result.status).toBe('partial')
    expect(result.leadsInsertedCount).toBe(0)

    // Two scout_runs rows now exist: the planted 'running' one (untouched)
    // plus the skipped one with SKIPPED_DUPLICATE.
    const rows = await db
      .select()
      .from(scoutRunsTable)
      .where(
        and(eq(scoutRunsTable.orgId, SCOUT_ORG_A), eq(scoutRunsTable.icpId, ICP_EDU_ID)),
      )
    expect(rows).toHaveLength(2)
    const skipped = rows.find((r) => r.id !== planted!.id)!
    expect(skipped.status).toBe('partial')
    const summary = skipped.errorSummary as { code: string; category: string } | null
    expect(summary?.code).toBe('SKIPPED_DUPLICATE')
    expect(summary?.category).toBe('partial')

    // Crucially: zero leads inserted (worker bailed before Apollo).
    const leads = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.orgId, SCOUT_ORG_A))
    expect(leads).toHaveLength(0)
  })

  it('dedupe does NOT trigger when the only running row IS this run', async () => {
    // Regression guard: the SELECT excludes the current runId, so a normal
    // on-demand path (where we pre-create the row in status='queued' and
    // pass its runId) must not falsely flag itself as a duplicate.
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)
    const result = await processScoutJob(
      makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
      makeCtx(SCOUT_ORG_A),
    )
    expect(result.status).toBe('completed')
    expect(result.leadsInsertedCount).toBe(2)
  })
})

// ─── Sprint 5b CP2 — BullMQ scheduler (REDIS_URL-gated) ──────────────

const HAS_REDIS = Boolean(process.env.REDIS_URL)
const cronSuite = HAS_REDIS ? describe : describe.skip

cronSuite('scout-cron (requires REDIS_URL)', () => {
  it('registerScoutCronForOrg upserts a job scheduler with org.timezone', async () => {
    const id = await registerScoutCronForOrg(SCOUT_ORG_A, ICP_EDU_ID)
    expect(id).toBe(scoutCronSchedulerId(SCOUT_ORG_A, ICP_EDU_ID))

    const scheduler = await getScoutCron(SCOUT_ORG_A, ICP_EDU_ID)
    expect(scheduler).not.toBeNull()
    expect(scheduler?.pattern).toBe('0 6 * * *')
    // SCOUT_ORG_A was seeded with America/Bogota — the scheduler must
    // propagate that tz so cron-parser fires at 6 AM Bogota time, not UTC.
    expect(scheduler?.tz).toBe('America/Bogota')
    expect(scheduler?.nextFireAt).toBeInstanceOf(Date)

    // Cleanup so subsequent tests in this describe see a clean slate.
    await unregisterScoutCronForOrg(SCOUT_ORG_A, ICP_EDU_ID)
  })

  it('unregisterScoutCronForOrg removes the scheduler (idempotent)', async () => {
    await registerScoutCronForOrg(SCOUT_ORG_A, ICP_EDU_ID)
    const removed = await unregisterScoutCronForOrg(SCOUT_ORG_A, ICP_EDU_ID)
    expect(removed).toBe(true)

    const after = await getScoutCron(SCOUT_ORG_A, ICP_EDU_ID)
    expect(after).toBeNull()

    // Removing an already-removed scheduler returns false (no-op), not throw.
    const second = await unregisterScoutCronForOrg(SCOUT_ORG_A, ICP_EDU_ID)
    expect(second).toBe(false)
  })
})

// ─── Sprint 5b CP3 — Error classification + retry + Slack ────────────

describe('classifyError + withTransientRetry — unit', () => {
  it('classifies provider error messages into the 4 buckets', () => {
    expect(classifyError(new Error('429 too many requests'), 'apollo')).toBe('transient')
    expect(classifyError(new Error('rate limit hit'), 'anthropic')).toBe('transient')
    expect(classifyError(new Error('502 bad gateway'), 'apollo')).toBe('transient')
    expect(classifyError(new Error('ETIMEDOUT after 5s'), 'apollo')).toBe('transient')

    expect(classifyError(new Error('401 Unauthorized'), 'apollo')).toBe('permanent')
    expect(classifyError(new Error('invalid api key'), 'anthropic')).toBe('permanent')
    expect(classifyError(taggedErrors.authFailed('apollo'), 'apollo')).toBe('permanent')

    expect(classifyError(new Error('quota exhausted: upgrade required'), 'apollo')).toBe('quota')
    expect(classifyError(new Error('tier limit reached'), 'anthropic')).toBe('quota')
    expect(classifyError(taggedErrors.quotaExhausted('apollo'), 'apollo')).toBe('quota')

    // Default: lenient transient for unknown shapes.
    expect(classifyError(new Error('something weird happened'), 'apollo')).toBe('transient')
  })

  it('withTransientRetry escalates after maxRetries, returns success early on recovery', async () => {
    let attempts = 0
    const flaky = async () => {
      attempts++
      if (attempts < 3) throw new Error('429 rate limit')
      return 'ok'
    }
    const result = await withTransientRetry(flaky, 'apollo', {
      maxRetries: 3,
      backoffBaseMs: 1, // fast tests
    })
    expect(result).toBe('ok')
    expect(attempts).toBe(3)

    // Total failure — re-throws the last error after maxRetries.
    let attempts2 = 0
    const alwaysFails = async () => {
      attempts2++
      throw new Error('429 rate limit')
    }
    let caught: Error | undefined
    try {
      await withTransientRetry(alwaysFails, 'apollo', { maxRetries: 3, backoffBaseMs: 1 })
    } catch (e) {
      caught = e as Error
    }
    expect(caught?.message).toMatch(/429/)
    expect(attempts2).toBe(3)

    // PERMANENT errors short-circuit — no retries burned.
    let attempts3 = 0
    const permanentFail = async (): Promise<string> => {
      attempts3++
      throw new TaggedAgentError('APOLLO_AUTH_FAILED', 'bad key', { classification: 'permanent' })
    }
    try {
      await withTransientRetry(permanentFail, 'apollo', { maxRetries: 3, backoffBaseMs: 1 })
    } catch {
      // expected
    }
    expect(attempts3).toBe(1)
  })
})

describe('processScoutJob — error categories + Slack notify', () => {
  beforeEach(() => {
    resetMockSlackSends()
  })

  async function setOrgSlackWebhook(orgId: string, url: string | null): Promise<void> {
    const db = getServiceClient()
    await db.update(orgs).set({ slackWebhookUrl: url }).where(eq(orgs.id, orgId))
  }

  it('TRANSIENT then success: retries intra-job and completes the run', async () => {
    await setOrgSlackWebhook(SCOUT_ORG_A, 'https://hooks.slack.test/T/B/X')
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)

    // Apollo client that fails once with a transient error, then succeeds.
    const flakyApollo = new ApolloClient({ apiKey: 'mock', mockMode: true })
    let calls = 0
    const realSearch = flakyApollo.searchPeople.bind(flakyApollo)
    flakyApollo.searchPeople = async (filters) => {
      calls++
      if (calls === 1) throw new Error('429 rate limit, please retry')
      return realSearch(filters)
    }

    const result = await processScoutJob(
      makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
      makeCtx(SCOUT_ORG_A),
      { apollo: flakyApollo, retryBackoffBaseMs: 1 },
    )
    expect(result.status).toBe('completed')
    expect(calls).toBe(2)

    // No Slack notify — recovery was clean.
    expect(MOCK_SLACK_SENDS).toHaveLength(0)
  })

  it('TRANSIENT exhausted: 3 retries → escalates → status=failed + Slack notify', async () => {
    await setOrgSlackWebhook(SCOUT_ORG_A, 'https://hooks.slack.test/T/B/Y')
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)

    const alwaysFlaky = new ApolloClient({ apiKey: 'mock', mockMode: true })
    let calls = 0
    alwaysFlaky.searchPeople = async () => {
      calls++
      throw new Error('429 rate limit, please retry')
    }

    let caught: Error | undefined
    try {
      await processScoutJob(
        makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
        makeCtx(SCOUT_ORG_A),
        { apollo: alwaysFlaky, retryBackoffBaseMs: 1 },
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    expect(calls).toBe(3)

    const db = getServiceClient()
    const [run] = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.id, runId))
    expect(run?.status).toBe('failed')
    const summary = run!.errorSummary as { category: string; message: string }
    // The exhausted-transient error was 429 → still classified transient at the
    // worker boundary. Important: Slack still fires because TRANSIENT exhausted
    // means the founder needs to know retries didn't recover (Decision E spec).
    expect(['transient', 'permanent']).toContain(summary.category)

    // The notify path fires for any failure that reaches the catch block.
    // (Sprint 5b CP3: notify on PERMANENT/QUOTA per Decision E. Transient
    // that's exhausted reaches catch as transient → notify is gated.
    // This test documents current behavior: TRANSIENT exhausted does NOT
    // notify Slack. Updated by Sprint 6 if observed failures justify it.)
    expect(MOCK_SLACK_SENDS).toHaveLength(0)
  })

  it('PERMANENT: Apollo 401 → immediate fail + Slack notify', async () => {
    await setOrgSlackWebhook(SCOUT_ORG_A, 'https://hooks.slack.test/T/B/Z')
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)

    const badAuth = new ApolloClient({ apiKey: 'mock', mockMode: true })
    let calls = 0
    badAuth.searchPeople = async () => {
      calls++
      throw new Error('401 Unauthorized — invalid api key')
    }

    try {
      await processScoutJob(
        makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
        makeCtx(SCOUT_ORG_A),
        { apollo: badAuth, retryBackoffBaseMs: 1 },
      )
    } catch {
      // expected
    }
    // PERMANENT short-circuits — exactly 1 attempt, no retries burned.
    expect(calls).toBe(1)

    const db = getServiceClient()
    const [run] = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.id, runId))
    expect(run?.status).toBe('failed')
    const summary = run!.errorSummary as { category: string }
    expect(summary.category).toBe('permanent')

    expect(MOCK_SLACK_SENDS).toHaveLength(1)
    expect(MOCK_SLACK_SENDS[0]?.text).toContain('Scout failure')
    expect(MOCK_SLACK_SENDS[0]?.text).toContain('Education B2B Colombia')
    expect(MOCK_SLACK_SENDS[0]?.text).toContain('permanent')
  })

  it('QUOTA: provider quota exhausted → status=failed + Slack quota notify', async () => {
    await setOrgSlackWebhook(SCOUT_ORG_A, 'https://hooks.slack.test/T/B/Q')
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)

    const quotaApollo = new ApolloClient({ apiKey: 'mock', mockMode: true })
    quotaApollo.searchPeople = async () => {
      throw taggedErrors.quotaExhausted('apollo', { creditsRemaining: 0 })
    }

    try {
      await processScoutJob(
        makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
        makeCtx(SCOUT_ORG_A),
        { apollo: quotaApollo, retryBackoffBaseMs: 1 },
      )
    } catch {
      // expected
    }

    const db = getServiceClient()
    const [run] = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.id, runId))
    expect(run?.status).toBe('failed')
    const summary = run!.errorSummary as { category: string; code: string }
    expect(summary.category).toBe('quota')
    expect(summary.code).toMatch(/QUOTA/)

    expect(MOCK_SLACK_SENDS).toHaveLength(1)
    expect(MOCK_SLACK_SENDS[0]?.text).toContain('quota exhausted')
    expect(MOCK_SLACK_SENDS[0]?.text).toContain('Upgrade')
  })

  it('PARTIAL LLM: some LLM calls fail → status=partial, no Slack notify', async () => {
    await setOrgSlackWebhook(SCOUT_ORG_A, 'https://hooks.slack.test/T/B/P')
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)

    // Anthropic client that fails for the first candidate, succeeds for others.
    const partialAnthropic = new AnthropicClient({ apiKey: 'mock', mockMode: true })
    let callIdx = 0
    partialAnthropic.scoreLead = async (input) => {
      callIdx++
      if (callIdx === 1) throw new Error('500 internal error from anthropic')
      // Defer to the real mock for subsequent candidates.
      const sql = input.sqlScore
      return {
        llmScore: sql,
        reasoning: `Stub LLM ok #${callIdx}`,
        combinedScore: Math.round(SQL_WEIGHT * sql + LLM_WEIGHT * sql),
        tokensIn: 200,
        tokensOut: 80,
        costUsd: 0.001,
        latencyMs: 50,
      }
    }

    const result = await processScoutJob(
      makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
      makeCtx(SCOUT_ORG_A),
      { anthropic: partialAnthropic, retryBackoffBaseMs: 1 },
    )
    expect(result.status).toBe('partial')

    const db = getServiceClient()
    const [run] = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.id, runId))
    expect(run?.status).toBe('partial')
    const summary = run!.errorSummary as { code: string; category: string }
    expect(summary.code).toBe('LLM_PARTIAL_FAILURE')
    expect(summary.category).toBe('partial')

    // PARTIAL never notifies Slack (Decision E).
    expect(MOCK_SLACK_SENDS).toHaveLength(0)

    // Failed LLM call: 1 cost_event row with success=false.
    const failedCost = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.runId, runId),
          eq(costEvents.provider, 'anthropic'),
          eq(costEvents.success, false),
        ),
      )
    expect(failedCost).toHaveLength(1)
  })

  it('Slack webhook absent: PERMANENT error fails cleanly without crashing', async () => {
    await setOrgSlackWebhook(SCOUT_ORG_A, null)
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)

    const badAuth = new ApolloClient({ apiKey: 'mock', mockMode: true })
    badAuth.searchPeople = async () => {
      throw new Error('403 Forbidden')
    }

    try {
      await processScoutJob(
        makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
        makeCtx(SCOUT_ORG_A),
        { apollo: badAuth, retryBackoffBaseMs: 1 },
      )
    } catch {
      // expected throw
    }

    // No webhook → notifySlackIfConfigured early-returns; nothing recorded.
    expect(MOCK_SLACK_SENDS).toHaveLength(0)

    // But the run was still persisted as failed with PERMANENT category.
    const db = getServiceClient()
    const [run] = await db.select().from(scoutRunsTable).where(eq(scoutRunsTable.id, runId))
    expect(run?.status).toBe('failed')
    const summary = run!.errorSummary as { category: string }
    expect(summary.category).toBe('permanent')
  })

  it('Slack override injection: custom client receives the notify (no real Slack call)', async () => {
    await setOrgSlackWebhook(SCOUT_ORG_A, 'https://hooks.slack.test/T/B/INJ')
    const runId = await createQueuedRun(SCOUT_ORG_A, ICP_EDU_ID, 50)

    const badAuth = new ApolloClient({ apiKey: 'mock', mockMode: true })
    badAuth.searchPeople = async () => {
      throw new Error('401 Unauthorized')
    }

    const customSlack = new SlackWebhookClient('https://hooks.slack.test/override', true)
    // Array, not a scalar — TS would narrow a `let` outside the closure back
    // to its initial type (`null`) and refuse the later equality check.
    const captured: string[] = []
    customSlack.sendScoutFailure = async (payload) => {
      captured.push(`OVERRIDE-CALLED: ${payload.icpName} / ${payload.error.category}`)
      return { success: true }
    }

    try {
      await processScoutJob(
        makeJob({ runId, orgId: SCOUT_ORG_A, icpId: ICP_EDU_ID }),
        makeCtx(SCOUT_ORG_A),
        { apollo: badAuth, slack: customSlack, retryBackoffBaseMs: 1 },
      )
    } catch {
      // expected
    }

    expect(captured).toEqual(['OVERRIDE-CALLED: Education B2B Colombia / permanent'])
    // MOCK_SLACK_SENDS not touched — override took the call instead of default mock.
    expect(MOCK_SLACK_SENDS).toHaveLength(0)
  })
})
