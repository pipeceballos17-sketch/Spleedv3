/**
 * Sprint 6a Profiler test suite.
 *
 * Coverage:
 *   - 4 unit tests for extractCompanyWebsiteSignals (the agent-layer fn)
 *   - 5 integration tests for processProfilerJob (DB end-to-end, BullMQ bypassed)
 *   - 2 multi-tenant isolation tests
 *   - 2 error-scenario tests
 *
 * Total: 13 tests.
 *
 * Strategy mirrors scout.test.ts: call `processProfilerJob` directly with a
 * synthetic ctx, exercising the full DB pipeline without spinning Redis.
 * BullMQ integration (the Scout → Profiler enqueue handshake under load)
 * lands in a Sprint 7 dedicated worker-orchestration test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { sql, and, eq } from 'drizzle-orm'
import pino from 'pino'
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
  AnthropicClient,
  type IcpShape,
} from '@spleed/integrations/anthropic'
import { VercelBrowserClient } from '@spleed/integrations/vercel-browser'
import {
  extractCompanyWebsiteSignals,
  type LeadShape,
} from '../agents/profiler'
import { TaggedAgentError } from '../runtime/errors'
import { createScopedDb, type WorkerContext } from '../workers/context'
import {
  processProfilerJob,
  type ProfilerJob,
} from '../workers/profiler.worker'

// ─── Constants ────────────────────────────────────────────────────────

const PROFILER_ORG_A = '66666666-6666-6666-6666-66666666aaaa'
const PROFILER_ORG_B = '66666666-6666-6666-6666-66666666bbbb'
const PROFILER_USER_A_ID = '66666666-6666-6666-6666-66666666aa11'
const PROFILER_USER_B_ID = '66666666-6666-6666-6666-66666666bb11'
const PROFILER_USER_A_AUTH = '66666666-6666-6666-6666-66666666aa22'
const PROFILER_USER_B_AUTH = '66666666-6666-6666-6666-66666666bb22'

const ICP_PROFILER_SAAS = '66666666-6666-6666-6666-666666660555'
const ICP_PROFILER_EDU = '66666666-6666-6666-6666-666666660ed0'
const ICP_PROFILER_FINTECH = '66666666-6666-6666-6666-666666660fb1'

// ─── Test helpers ─────────────────────────────────────────────────────

const silentLogger = pino({ level: 'silent' })

function makeCtx(orgId: string, traceId = `profiler-test-${Date.now()}`): WorkerContext {
  return {
    orgId,
    jobId: traceId,
    traceId,
    attemptsMade: 0,
    logger: silentLogger,
    db: createScopedDb(orgId),
  }
}

function makeJob(override: Partial<ProfilerJob> & { leadId: string; orgId: string }): {
  data: ProfilerJob
} {
  return {
    data: {
      triggerType: 'manual',
      ...override,
    },
  }
}

interface LeadSeed {
  id?: string
  orgId: string
  icpId?: string | null
  fullName: string
  firstName: string
  lastName: string
  company: string
  role: string
  companyDomain?: string | null
  email?: string | null
  status?: 'discovered' | 'enriching' | 'enriched'
}

async function createLead(seed: LeadSeed): Promise<string> {
  const db = getServiceClient()
  const [row] = await db
    .insert(leadsTable)
    .values({
      orgId: seed.orgId,
      icpId: seed.icpId ?? null,
      status: seed.status ?? 'discovered',
      fullName: seed.fullName,
      firstName: seed.firstName,
      lastName: seed.lastName,
      company: seed.company,
      role: seed.role,
      companyDomain: seed.companyDomain ?? null,
      email: seed.email ?? null,
      foundVia: 'profiler_test',
      fitScore: 80,
    })
    .returning({ id: leadsTable.id })
  return row!.id
}

async function seedProfilerFixtures(): Promise<void> {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)

  await db.insert(orgs).values([
    { id: PROFILER_ORG_A, name: 'Profiler Test Org A', slug: 'profiler-org-a' },
    { id: PROFILER_ORG_B, name: 'Profiler Test Org B', slug: 'profiler-org-b' },
  ])
  await db.insert(users).values([
    {
      id: PROFILER_USER_A_ID,
      supabaseAuthId: PROFILER_USER_A_AUTH,
      email: 'a@profiler.test',
      name: 'A',
    },
    {
      id: PROFILER_USER_B_ID,
      supabaseAuthId: PROFILER_USER_B_AUTH,
      email: 'b@profiler.test',
      name: 'B',
    },
  ])
  await db.insert(orgMembers).values([
    { orgId: PROFILER_ORG_A, userId: PROFILER_USER_A_ID, role: 'owner' },
    { orgId: PROFILER_ORG_B, userId: PROFILER_USER_B_ID, role: 'owner' },
  ])

  await db.insert(icpsTable).values([
    {
      id: ICP_PROFILER_SAAS,
      orgId: PROFILER_ORG_A,
      name: 'SaaS B2B Founders US',
      definitionNaturalLanguage:
        'Technical founders of B2B SaaS startups in the US, pre-seed/seed, modern stack.',
      parsedFilters: {
        version: '1',
        industries: ['saas'],
        titles: ['Founder', 'CEO', 'CTO'],
        seniorities: ['founder', 'c_suite'],
      },
    },
    {
      id: ICP_PROFILER_EDU,
      orgId: PROFILER_ORG_A,
      name: 'Education B2B Colombia',
      definitionNaturalLanguage:
        'Directors / Rectors at private schools in Colombia, 30-500 students.',
      parsedFilters: {
        version: '1',
        industries: ['education'],
        geos: ['Colombia'],
        titles: ['Director', 'Rector'],
      },
    },
    {
      id: ICP_PROFILER_FINTECH,
      orgId: PROFILER_ORG_B,
      name: 'Fintech CFOs LatAm',
      definitionNaturalLanguage: 'CFOs at fintech companies in LatAm, 30-200 employees.',
      parsedFilters: {
        version: '1',
        industries: ['fintech'],
        geos: ['Colombia', 'Mexico'],
        titles: ['CFO', 'CEO'],
      },
    },
  ])
}

async function cleanProfilerState(): Promise<void> {
  const db = getServiceClient()
  // Order matters: lead_dossiers FK leads.id with cascade, but we clean
  // dossiers first to keep semantics explicit (parallel to scout test's
  // ordered cleanup).
  await db
    .delete(leadDossiersTable)
    .where(sql`org_id IN (${PROFILER_ORG_A}::uuid, ${PROFILER_ORG_B}::uuid)`)
  await db
    .delete(leadsTable)
    .where(sql`org_id IN (${PROFILER_ORG_A}::uuid, ${PROFILER_ORG_B}::uuid)`)
  await db
    .delete(costEvents)
    .where(sql`org_id IN (${PROFILER_ORG_A}::uuid, ${PROFILER_ORG_B}::uuid)`)
}

// ─── Suite setup ──────────────────────────────────────────────────────

beforeAll(async () => {
  await seedProfilerFixtures()
})

afterAll(async () => {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await closeServiceClient()
})

beforeEach(async () => {
  await cleanProfilerState()
})

// ─── 1-4. extractCompanyWebsiteSignals (unit) ─────────────────────────

const SAAS_ICP: IcpShape = {
  name: 'SaaS B2B Founders US',
  definitionNaturalLanguage:
    'Technical founders of B2B SaaS startups in the US.',
  parsedFilters: {
    industries: ['saas'],
    titles: ['Founder', 'CEO'],
    seniorities: ['founder', 'c_suite'],
  },
}

const EDU_ICP: IcpShape = {
  name: 'Education B2B Colombia',
  definitionNaturalLanguage: 'Rectors / Directors at private schools.',
  parsedFilters: {
    industries: ['education'],
    geos: ['Colombia'],
  },
}

describe('extractCompanyWebsiteSignals — unit', () => {
  it('Sarah Chen (pulseanalytics.io) → company_stage=series-a + hook_candidates with UUIDs', async () => {
    const vercel = new VercelBrowserClient()
    const anthropic = new AnthropicClient({ apiKey: 'mock' })
    const lead: LeadShape = {
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder & CEO',
      companyDomain: 'pulseanalytics.io',
      email: 'sarah@pulseanalytics.io',
    }
    const scrape = await vercel.scrapeCompanyWebsite('pulseanalytics.io')

    const result = await extractCompanyWebsiteSignals({
      pageContent: scrape.pageContent,
      lead,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })

    expect(result.signals.company_stage).toBe('series-a')
    expect(result.signals.hook_candidates.length).toBeGreaterThan(0)
    expect(result.signals.recent_news.length).toBeGreaterThan(0)
    // Every hook must carry a freshly minted uuid.
    for (const hc of result.signals.hook_candidates) {
      expect(hc.hookId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(hc.evidence).toBeTruthy()
      expect(hc.confidence).toBeGreaterThan(0)
      expect(hc.confidence).toBeLessThanOrEqual(1)
    }
    // Cost is non-zero so cost_events later land with real numbers.
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.tokensIn).toBe(1800)
    expect(result.tokensOut).toBe(500)
  })

  it('Laura Pérez (colegiosanandres.edu.co) → company_stage=enterprise + EAFIT in recent_news', async () => {
    const vercel = new VercelBrowserClient()
    const anthropic = new AnthropicClient({ apiKey: 'mock' })
    const lead: LeadShape = {
      fullName: 'Laura Pérez',
      firstName: 'Laura',
      lastName: 'Pérez',
      company: 'Colegio San Andrés',
      role: 'Director of Academics',
      companyDomain: 'colegiosanandres.edu.co',
    }
    const scrape = await vercel.scrapeCompanyWebsite('colegiosanandres.edu.co')

    const result = await extractCompanyWebsiteSignals({
      pageContent: scrape.pageContent,
      lead,
      icp: EDU_ICP,
      anthropicClient: anthropic,
    })

    expect(result.signals.company_stage).toBe('enterprise')
    // Curated mock embeds the EAFIT articulación news — guards against silent
    // drift in vercel-browser/mock.ts or anthropic mock alignment.
    const eafitMention = result.signals.recent_news.find((n) =>
      n.toLowerCase().includes('eafit'),
    )
    expect(eafitMention).toBeDefined()
    // Education sector typically has zero hiring signals in the mock (stable
    // institution); confirm we model that correctly.
    expect(result.signals.hiring_signals.length).toBe(0)
  })

  it('unknown domain → graceful empty signals (no error)', async () => {
    const anthropic = new AnthropicClient({ apiKey: 'mock' })
    const lead: LeadShape = {
      fullName: 'Anonymous Founder',
      firstName: 'Anon',
      lastName: 'Founder',
      company: 'Nowhere Co',
      role: 'Founder',
      companyDomain: 'nowhere-co-12345.example',
    }

    const result = await extractCompanyWebsiteSignals({
      pageContent: {
        title: 'Nowhere Co',
        mainText: 'No content yet.',
      },
      lead,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })

    expect(result.signals.company_stage).toBe('unknown')
    expect(result.signals.hook_candidates).toEqual([])
    expect(result.signals.pain_signals).toEqual([])
    expect(result.signals.recent_news).toEqual([])
    expect(result.signals.hiring_signals).toEqual([])
    expect(result.signals.growth_signals).toEqual([])
    // Cost still recorded so the founder sees the failed-extraction spend.
    expect(result.costUsd).toBeGreaterThan(0)
  })

  it('deterministic mock latency for the same domain hint', async () => {
    const anthropic = new AnthropicClient({ apiKey: 'mock' })
    const lead: LeadShape = {
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
    }
    const vercel = new VercelBrowserClient()
    const scrape = await vercel.scrapeCompanyWebsite('pulseanalytics.io')

    const r1 = await extractCompanyWebsiteSignals({
      pageContent: scrape.pageContent,
      lead,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })
    const r2 = await extractCompanyWebsiteSignals({
      pageContent: scrape.pageContent,
      lead,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })

    // Same domainHint → same mockProfilerLatencyMs output, regardless of
    // wall-clock between calls. hookIds change (uuid v4) — that's expected.
    expect(r1.latencyMs).toBe(r2.latencyMs)
    expect(r1.tokensIn).toBe(r2.tokensIn)
    expect(r1.tokensOut).toBe(r2.tokensOut)
    expect(r1.signals.company_stage).toBe(r2.signals.company_stage)
  })
})

// ─── 5-9. processProfilerJob integration ──────────────────────────────

describe('processProfilerJob — end-to-end pipeline', () => {
  it('happy path: discovered Sarah Chen → enriched + populated dossier', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder & CEO',
      companyDomain: 'pulseanalytics.io',
      email: 'sarah@pulseanalytics.io',
    })

    const result = await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A, triggerType: 'auto_from_scout' }),
      makeCtx(PROFILER_ORG_A),
    )

    expect(result.status).toBe('enriched')
    expect(result.hookCount).toBeGreaterThan(0)
    expect(result.costUsd).toBeGreaterThan(0)

    const db = getServiceClient()
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId))
    expect(lead?.status).toBe('enriched')
    expect(lead?.enrichedAt).toBeInstanceOf(Date)

    const [dossier] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    expect(dossier).toBeDefined()
    expect(dossier?.enrichedBy).toBe('profiler_agent_v1')
    expect((dossier?.pains as unknown[]).length).toBeGreaterThan(0)
    expect((dossier?.interests as unknown[]).length).toBeGreaterThan(0)
    expect((dossier?.recentChanges as unknown[]).length).toBeGreaterThan(0)
    expect(dossier?.confidenceScore).toBeGreaterThan(0)
    // rawSignals.companyWebsiteSignals roundtrips the full extraction.
    const raw = dossier?.rawSignals as { companyWebsiteSignals?: { company_stage?: string } }
    expect(raw.companyWebsiteSignals?.company_stage).toBe('series-a')
  })

  it('writes one cost_event per provider (vercel_browser + anthropic)', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
    })

    await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A, triggerType: 'auto_from_scout' }),
      makeCtx(PROFILER_ORG_A),
    )

    const db = getServiceClient()
    const events = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.orgId, PROFILER_ORG_A),
          eq(costEvents.agentType, 'profiler'),
        ),
      )

    expect(events).toHaveLength(2)
    const vercelEvent = events.find((e) => e.provider === 'vercel_browser')
    const anthropicEvent = events.find((e) => e.provider === 'anthropic')
    expect(vercelEvent?.operationType).toBe('scrape_company')
    expect(vercelEvent?.success).toBe(true)
    expect(Number(vercelEvent?.costUsd)).toBeGreaterThan(0)
    expect(anthropicEvent?.operationType).toBe('extraction_company_website')
    expect(anthropicEvent?.success).toBe(true)
    expect(anthropicEvent?.tokensIn).toBe(1800)
    expect(anthropicEvent?.tokensOut).toBe(500)
  })

  it('lead without companyDomain → enriched with empty dossier (graceful)', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Manual Lead',
      firstName: 'Manual',
      lastName: 'Lead',
      company: 'No Website Co',
      role: 'Founder',
      companyDomain: null,
    })

    const result = await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    expect(result.status).toBe('enriched')
    expect(result.hookCount).toBe(0)
    expect(result.costUsd).toBe(0)

    const db = getServiceClient()
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId))
    expect(lead?.status).toBe('enriched')
    const [dossier] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    // Seed-row upsert ran, no signals populated — empty pains/interests/etc.
    expect(dossier).toBeDefined()
    expect((dossier?.pains as unknown[]).length).toBe(0)
    expect((dossier?.interests as unknown[]).length).toBe(0)
    // No Vercel + Anthropic calls were made — zero cost_events.
    const events = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.orgId, PROFILER_ORG_A),
          eq(costEvents.agentType, 'profiler'),
        ),
      )
    expect(events).toHaveLength(0)
  })

  it('lead with no icpId → status="skipped", lead.status unchanged', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: null,
      fullName: 'Orphan Lead',
      firstName: 'Orphan',
      lastName: 'Lead',
      company: 'No ICP Co',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      status: 'discovered',
    })

    const result = await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    expect(result.status).toBe('skipped')
    expect(result.hookCount).toBe(0)

    const db = getServiceClient()
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId))
    // No state mutation: leads.status remains 'discovered', enrichedAt null,
    // no dossier row was inserted.
    expect(lead?.status).toBe('discovered')
    expect(lead?.enrichedAt).toBeNull()
    const dossiers = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    expect(dossiers).toHaveLength(0)
  })

  it('signal-sparse Wallace Steel → enriched with empty signals + confidenceScore=0', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Henry Wallace',
      firstName: 'Henry',
      lastName: 'Wallace',
      company: 'Wallace Steel Co.',
      role: 'Plant Manager',
      companyDomain: 'wallacesteel.com',
    })

    const result = await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    // Curated wallacesteel mock returns empty arrays for all signals — the
    // worker still completes successfully with confidenceScore=0.
    expect(result.status).toBe('enriched')
    expect(result.hookCount).toBe(0)

    const db = getServiceClient()
    const [dossier] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    expect(dossier?.confidenceScore).toBe(0)
    expect((dossier?.pains as unknown[]).length).toBe(0)
    expect((dossier?.interests as unknown[]).length).toBe(0)
  })
})

// ─── 10-11. Multi-tenant isolation ────────────────────────────────────

describe('Profiler — multi-tenant isolation', () => {
  it('Org A enrichment does not surface dossier in Org B-scoped queries', async () => {
    const leadAId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
    })

    await processProfilerJob(
      makeJob({ leadId: leadAId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    const db = getServiceClient()
    // Org B-scoped query — the dossier exists in the DB but must be invisible
    // to Org B (app-layer filter + RLS in production).
    const dossiersFromB = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.orgId, PROFILER_ORG_B))
    expect(dossiersFromB).toHaveLength(0)

    // Sanity: Org A sees its own dossier.
    const dossiersFromA = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.orgId, PROFILER_ORG_A))
    expect(dossiersFromA).toHaveLength(1)
  })

  it('cost_events scoped to enriching org only', async () => {
    const leadAId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
    })
    await processProfilerJob(
      makeJob({ leadId: leadAId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    const db = getServiceClient()
    const eventsB = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.orgId, PROFILER_ORG_B))
    expect(eventsB).toHaveLength(0)

    const eventsA = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.orgId, PROFILER_ORG_A))
    expect(eventsA.length).toBeGreaterThan(0)
  })
})

// ─── 12-13. Error scenarios ───────────────────────────────────────────

describe('Profiler — error handling', () => {
  it('Vercel browser PERMANENT failure → leads.status reverts + dossier deleted', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
    })

    // Patch scrape to throw an auth-failed style error — classifyError will
    // bucket as PERMANENT, escalating immediately past withTransientRetry.
    const failingVercel = new VercelBrowserClient()
    failingVercel.scrapeCompanyWebsite = async () => {
      throw new Error('VERCEL_AUTH_FAILED: invalid api key')
    }

    let caught: unknown
    try {
      await processProfilerJob(
        makeJob({ leadId, orgId: PROFILER_ORG_A }),
        makeCtx(PROFILER_ORG_A),
        // Fast backoff keeps retry escalation under a few ms.
        { vercel: failingVercel, retryBackoffBaseMs: 1 },
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)

    const db = getServiceClient()
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId))
    // Revert to 'discovered' so a re-trigger can attempt fresh.
    expect(lead?.status).toBe('discovered')
    // Partial dossier deleted — next run starts clean.
    const dossiers = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    expect(dossiers).toHaveLength(0)

    // Failure-path cost_event recorded (success=false).
    const events = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.orgId, PROFILER_ORG_A),
          eq(costEvents.provider, 'vercel_browser'),
        ),
      )
    expect(events).toHaveLength(1)
    expect(events[0]?.success).toBe(false)
    expect(events[0]?.errorCode).toContain('VERCEL_AUTH_FAILED')
  })

  it('non-existent leadId → throws TaggedAgentError(LEAD_NOT_FOUND)', async () => {
    const fakeLeadId = '66666666-6666-6666-6666-66666666dead'
    let caught: unknown
    try {
      await processProfilerJob(
        makeJob({ leadId: fakeLeadId, orgId: PROFILER_ORG_A }),
        makeCtx(PROFILER_ORG_A),
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TaggedAgentError)
    expect((caught as TaggedAgentError).tag).toBe('LEAD_NOT_FOUND')
    expect((caught as TaggedAgentError).classification).toBe('permanent')
  })
})
