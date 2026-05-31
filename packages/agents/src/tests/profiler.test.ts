/**
 * Profiler test suite (Sprint 6a + Sprint 6b).
 *
 * Sprint 6a coverage (13 tests):
 *   - 4 unit tests for extractCompanyWebsiteSignals
 *   - 5 integration tests for processProfilerJob (single-source flow)
 *   - 2 multi-tenant isolation
 *   - 2 error-scenario
 *
 * Sprint 6b additions (12 tests, target 25 total):
 *   - 3 unit (linkedin / news / synthesis extractions)
 *   - 4 integration (full 3-source / linkedin fail / news retry / all-fail)
 *   - 1 synthesis dedupe edge
 *   - 1 evidence_urls populated
 *   - 1 cross-org evidence_urls isolation
 *   - 1 Apify mock determinism
 *   - 1 partial enrichment test re-purposed in-place from Sprint 6a #12
 *
 * Strategy mirrors scout.test.ts: call `processProfilerJob` directly
 * with a synthetic ctx, exercising the full DB pipeline without
 * spinning Redis. BullMQ integration lands in a Sprint 7 dedicated
 * worker-orchestration test.
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
import { ApifyClient } from '@spleed/integrations/apify'
import {
  MOCK_SLACK_SENDS,
  SlackClient,
  SlackWebhookClient,
  resetMockSlackSends,
} from '@spleed/integrations/slack'
import { VercelBrowserClient } from '@spleed/integrations/vercel-browser'
import type { BrowserOrchestrator } from '@spleed/integrations/browser'
import { DeepResearchAgent } from '../agents/deep-research'
import {
  extractCompanyWebsiteSignals,
  extractLinkedinSignals,
  extractNewsSignals,
  synthesizeDossier,
  type LeadShape,
  type SynthesisSourceInput,
} from '../agents/profiler'
import { TaggedAgentError } from '../runtime/errors'
import { createScopedDb, type WorkerContext } from '../workers/context'
import {
  processProfilerJob,
  type ProfilerJob,
} from '../workers/profiler.worker'
import { processConciergeJob } from '../workers/concierge.worker'

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

/**
 * Sprint 9 CP2 — a BrowserOrchestrator stub that always blocks (Tier 1 then
 * Tier 2 both fail). Used to simulate a company-website scrape failure now that
 * the worker scrapes via the orchestrator instead of ctx.vercel directly.
 */
function blockingBrowser(blockedBy: 'imperva' | 'cloudflare' | 'unknown' = 'imperva'): BrowserOrchestrator {
  return {
    scrape: async () => ({
      success: false as const,
      tierUsed: 'vercel_browser' as const,
      costUsd: 0.003,
      blockedBy,
      errorMessage: `blocked_by=${blockedBy}`,
      latencyMs: 5,
      attempts: [
        { tier: 'http_direct' as const, costUsd: 0, latencyMs: 2, success: false, blockedBy: 'cloudflare' as const },
        { tier: 'vercel_browser' as const, costUsd: 0.003, latencyMs: 3, success: false, blockedBy },
      ],
    }),
  } as unknown as BrowserOrchestrator
}

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
  /** Sprint 6b — Profiler LinkedIn source uses this URL when present. */
  linkedinUrl?: string | null
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
      linkedinUrl: seed.linkedinUrl ?? null,
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
    // enrichedBy tracks the worker version: v1 (Sprint 6a single-source) →
    // v2 (Sprint 6b 3-source) → v3 (Sprint 7b deep research pipeline).
    // Sarah pulseanalytics Phase 6 confidence 0.88 ≥ 0.75 → Phase 7 skips,
    // but the worker is v3 so the stamp is v3 regardless.
    expect(dossier?.enrichedBy).toBe('profiler_agent_v3')
    expect((dossier?.pains as unknown[]).length).toBeGreaterThan(0)
    expect((dossier?.interests as unknown[]).length).toBeGreaterThan(0)
    expect((dossier?.recentChanges as unknown[]).length).toBeGreaterThan(0)
    expect(dossier?.confidenceScore).toBeGreaterThan(0)
    // rawSignals.companyWebsiteSignals roundtrips the full extraction.
    const raw = dossier?.rawSignals as { companyWebsiteSignals?: { company_stage?: string } }
    expect(raw.companyWebsiteSignals?.company_stage).toBe('series-a')
  })

  it('Sprint 6b cost_events: 8 rows for full 3-source enrichment', async () => {
    // Full enrichment writes one cost_event per provider operation:
    //   vercel_browser × 2 (company website scrape, news scrape)
    //   apify × 2          (linkedin profile, linkedin posts)
    //   anthropic × 4      (3 extractions + 1 synthesis)
    // Total = 8. Each row carries provider/operation_type/cost_usd so
    // dashboards can roll up cost by source.
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
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

    expect(events).toHaveLength(8)

    // Provider breakdown — 2 vercel + 2 apify + 4 anthropic.
    const byProvider = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.provider] = (acc[e.provider] ?? 0) + 1
      return acc
    }, {})
    expect(byProvider['vercel_browser']).toBe(2)
    expect(byProvider['apify']).toBe(2)
    expect(byProvider['anthropic']).toBe(4)

    // All 8 operation_types must appear (set sanity check). Sprint 9 CP2:
    // the company scrape is tier-orchestrated — Tier 1 (HTTP-direct) succeeds
    // in mock, so the op is browser_scrape_http_direct (was scrape_company).
    const opTypes = new Set(events.map((e) => e.operationType))
    expect(opTypes).toContain('browser_scrape_http_direct')
    expect(opTypes).toContain('extraction_company_website')
    expect(opTypes).toContain('scrape_profile')
    expect(opTypes).toContain('scrape_posts')
    expect(opTypes).toContain('extraction_linkedin')
    expect(opTypes).toContain('scrape_news')
    expect(opTypes).toContain('extraction_news')
    expect(opTypes).toContain('synthesis')

    // Synthesis cost row carries token counts (Sonnet 4.6 ~2200 in / 600 out).
    const synthesis = events.find((e) => e.operationType === 'synthesis')
    expect(synthesis?.tokensIn).toBe(2200)
    expect(synthesis?.tokensOut).toBe(600)
    expect(synthesis?.success).toBe(true)
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
  it('Sprint 6b: company_website PERMANENT failure → partial enrichment (linkedin + news succeed)', async () => {
    // Sprint 6a tested single-source failure as full revert. Sprint 6b
    // refactors to Promise.allSettled across 3 sources, so a single
    // failure becomes partial enrichment instead — only ALL-3-fail
    // triggers the revert path (covered by a separate test below).
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    })

    // Sprint 9 CP2 — the company-website scrape runs through the browser
    // orchestrator now; inject a blocking one. News (ctx.vercel.scrapeGoogleNews)
    // + LinkedIn (Apify) use the default mock clients, so they still succeed.
    const result = await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
      { browser: blockingBrowser('imperva'), retryBackoffBaseMs: 1 },
    )

    expect(result.status).toBe('enriched')
    expect(result.failedSources).toEqual(['company_website'])
    expect(result.successfulSources).toContain('linkedin')
    expect(result.successfulSources).toContain('news')

    const db = getServiceClient()
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId))
    expect(lead?.status).toBe('enriched')

    const [dossier] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    expect(dossier).toBeDefined()
    const raw = dossier?.rawSignals as {
      partialEnrichment?: boolean
      missingSources?: string[]
      companyWebsiteSignals?: unknown
      linkedinSignals?: unknown
      newsSignals?: unknown
    }
    expect(raw.partialEnrichment).toBe(true)
    expect(raw.missingSources).toEqual(['company_website'])
    expect(raw.companyWebsiteSignals).toBeNull()
    expect(raw.linkedinSignals).not.toBeNull()
    expect(raw.newsSignals).not.toBeNull()

    // Failed browser_scrape cost_events recorded per tier attempt (dashboards
    // see the blocked spend + the blocking reason in metadata).
    const failedEvents = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.orgId, PROFILER_ORG_A),
          eq(costEvents.provider, 'vercel_browser'),
          eq(costEvents.success, false),
        ),
      )
    expect(failedEvents.length).toBeGreaterThanOrEqual(1)
    expect(failedEvents.every((e) => e.operationType.startsWith('browser_scrape_'))).toBe(true)
    expect((failedEvents.at(-1)?.metadata as { blocked_by?: string }).blocked_by).toBe('imperva')
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

// ─── 14-15. Sprint 6b — LinkedIn + News extraction units ─────────────

describe('extractLinkedinSignals — unit (Sprint 6b)', () => {
  it('Sarah Chen profile + posts → series-a stage + Series A hook + UUIDs', async () => {
    const apify = new ApifyClient()
    const anthropic = new AnthropicClient({ apiKey: 'mock' })
    const profile = await apify.scrapeLinkedinProfile(
      'https://linkedin.com/in/sarahchen',
    )
    const posts = await apify.scrapeLinkedinPosts('https://linkedin.com/in/sarahchen')

    const lead: LeadShape = {
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder & CEO',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    }

    const result = await extractLinkedinSignals({
      profile: profile.profile,
      posts: posts.posts,
      lead,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })

    expect(result.signals.company_stage).toBe('series-a')
    expect(result.signals.hook_candidates.length).toBeGreaterThan(0)
    // Series A specifically — curated LinkedIn extraction mock cites the
    // 412-reaction post quote.
    const seriesAHook = result.signals.hook_candidates.find((h) =>
      h.hook.toLowerCase().includes('series a'),
    )
    expect(seriesAHook).toBeDefined()
    expect(seriesAHook?.evidence.toLowerCase()).toContain('costanoa')

    // Every hook carries a fresh uuid stamped by the agent layer.
    for (const hc of result.signals.hook_candidates) {
      expect(hc.hookId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
    }
    expect(result.tokensIn).toBe(1800)
    expect(result.tokensOut).toBe(500)
  })
})

describe('extractNewsSignals — unit (Sprint 6b)', () => {
  it('pulseanalytics.io news articles → series-a + TechCrunch coverage in recent_news', async () => {
    const vercel = new VercelBrowserClient()
    const anthropic = new AnthropicClient({ apiKey: 'mock' })
    const news = await vercel.scrapeGoogleNews(
      '"Pulse Analytics" OR site:pulseanalytics.io',
    )

    const lead: LeadShape = {
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
    }

    const result = await extractNewsSignals({
      articles: news.articles,
      lead,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })

    expect(result.signals.company_stage).toBe('series-a')
    const techCrunchMention = result.signals.recent_news.find((n) =>
      n.toLowerCase().includes('techcrunch'),
    )
    expect(techCrunchMention).toBeDefined()
    expect(result.signals.hook_candidates.length).toBeGreaterThan(0)
    expect(result.tokensIn).toBe(1200)
    expect(result.tokensOut).toBe(400)
  })
})

// ─── 16. Sprint 6b — Synthesis unit ─────────────────────────────────

describe('synthesizeDossier — unit (Sprint 6b)', () => {
  it('Sarah Chen 3 sources high quality → confidence 0.88 + dedupe (5→3 hooks)', async () => {
    // Drive all 3 extractions first, then feed into synthesis. This is
    // the same pipeline processProfilerJob runs internally, but exercised
    // in isolation so failures here pinpoint synthesis specifically.
    const apify = new ApifyClient()
    const vercel = new VercelBrowserClient()
    const anthropic = new AnthropicClient({ apiKey: 'mock' })
    const lead: LeadShape = {
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    }

    const webScrape = await vercel.scrapeCompanyWebsite('pulseanalytics.io')
    const webExtract = await extractCompanyWebsiteSignals({
      pageContent: webScrape.pageContent,
      lead,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })
    const profile = await apify.scrapeLinkedinProfile('https://linkedin.com/in/sarahchen')
    const posts = await apify.scrapeLinkedinPosts('https://linkedin.com/in/sarahchen')
    const liExtract = await extractLinkedinSignals({
      profile: profile.profile,
      posts: posts.posts,
      lead,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })
    const news = await vercel.scrapeGoogleNews('"Pulse Analytics" OR site:pulseanalytics.io')
    const newsExtract = await extractNewsSignals({
      articles: news.articles,
      lead,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })

    const totalRawHooks =
      webExtract.signals.hook_candidates.length +
      liExtract.signals.hook_candidates.length +
      newsExtract.signals.hook_candidates.length
    expect(totalRawHooks).toBe(5)

    const sources: SynthesisSourceInput[] = [
      { sourceName: 'company_website', signals: webExtract.signals },
      { sourceName: 'linkedin', signals: liExtract.signals },
      { sourceName: 'news', signals: newsExtract.signals },
    ]

    const synthesis = await synthesizeDossier({
      sources,
      partialEnrichment: false,
      missingSources: [],
      lead,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })

    // Curated dossier confidence for pulseanalytics.io = 0.88 (full 3 sources).
    expect(synthesis.confidenceScore).toBe(0.88)
    // Dedupe: 5 raw → 3 synthesis hooks.
    expect(synthesis.hookCandidates.length).toBe(3)
    // recommendedAngle MUST cite a specific source per PROFILER_SYNTHESIS_PROMPT.
    expect(synthesis.recommendedAngle.toLowerCase()).toContain('techcrunch')
    // painInferred is a sentence-level synthesis.
    expect(synthesis.painInferred.length).toBeGreaterThan(0)
  })
})

// ─── 17-20. Sprint 6b — Worker integration ──────────────────────────

describe('processProfilerJob — Sprint 6b full pipeline', () => {
  it('full 3-source enrichment Sarah Chen → successfulSources=3 + evidence_urls across 3 source types', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder & CEO',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    })

    const result = await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A, triggerType: 'auto_from_scout' }),
      makeCtx(PROFILER_ORG_A),
    )

    expect(result.status).toBe('enriched')
    expect(result.successfulSources).toEqual([
      'company_website',
      'linkedin',
      'news',
    ])
    expect(result.failedSources).toEqual([])
    // Full enrichment: total cost ~$0.156 (per CP3 demo). Bound loosely
    // to tolerate minor token tweaks in the mock.
    expect(result.costUsd).toBeGreaterThan(0.14)
    expect(result.costUsd).toBeLessThan(0.18)

    const db = getServiceClient()
    const [dossier] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    const raw = dossier?.rawSignals as {
      partialEnrichment?: boolean
      missingSources?: string[]
      synthesis?: { hookCandidates?: unknown[]; recommendedAngle?: string }
      companyWebsiteSignals?: unknown
      linkedinSignals?: unknown
      newsSignals?: unknown
    }
    expect(raw.partialEnrichment).toBe(false)
    expect(raw.missingSources).toEqual([])
    expect(raw.synthesis?.hookCandidates).toBeDefined()
    expect((raw.synthesis?.hookCandidates as unknown[])?.length).toBe(3)
    expect(raw.companyWebsiteSignals).not.toBeNull()
    expect(raw.linkedinSignals).not.toBeNull()
    expect(raw.newsSignals).not.toBeNull()

    // evidence_urls has entries from all 3 source types.
    const evidenceUrls = dossier?.evidenceUrls as Array<{ sourceType: string }>
    const sourceTypes = new Set(evidenceUrls.map((e) => e.sourceType))
    expect(sourceTypes).toEqual(new Set(['company_website', 'linkedin', 'news']))
  })

  it('LinkedIn PERMANENT failure → partial enrichment (linkedinSignals=null)', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    })

    const failingApify = new ApifyClient()
    failingApify.scrapeLinkedinProfile = async () => {
      throw new Error('APIFY_AUTH_FAILED: invalid token')
    }
    failingApify.scrapeLinkedinPosts = async () => {
      throw new Error('APIFY_AUTH_FAILED: invalid token')
    }

    const result = await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
      { apify: failingApify, retryBackoffBaseMs: 1 },
    )

    expect(result.status).toBe('enriched')
    expect(result.failedSources).toEqual(['linkedin'])
    expect(result.successfulSources).toContain('company_website')
    expect(result.successfulSources).toContain('news')

    const db = getServiceClient()
    const [dossier] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    const raw = dossier?.rawSignals as {
      partialEnrichment?: boolean
      missingSources?: string[]
      linkedinSignals?: unknown
      companyWebsiteSignals?: unknown
      newsSignals?: unknown
    }
    expect(raw.partialEnrichment).toBe(true)
    expect(raw.missingSources).toEqual(['linkedin'])
    expect(raw.linkedinSignals).toBeNull()
    expect(raw.companyWebsiteSignals).not.toBeNull()
    expect(raw.newsSignals).not.toBeNull()
  })

  it('News TRANSIENT failure (rate-limit) → withTransientRetry recovers, full enrichment', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    })

    // Same Vercel instance for company_website + news. Patch ONLY
    // scrapeGoogleNews to throw a rate-limit on attempts 1-2 then succeed.
    const flakyVercel = new VercelBrowserClient()
    const originalScrape = flakyVercel.scrapeGoogleNews.bind(flakyVercel)
    let newsAttempts = 0
    flakyVercel.scrapeGoogleNews = async (query, options) => {
      newsAttempts++
      if (newsAttempts < 3) {
        throw new Error('rate limit 429 — please retry')
      }
      return originalScrape(query, options)
    }

    const result = await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
      { vercel: flakyVercel, retryBackoffBaseMs: 1, retryMaxAttempts: 3 },
    )

    // withTransientRetry: attempt 1 fail, attempt 2 fail, attempt 3 OK.
    expect(newsAttempts).toBe(3)
    expect(result.status).toBe('enriched')
    expect(result.successfulSources).toContain('news')
    expect(result.failedSources).toEqual([])
  })

  it('ALL 3 sources fail → leads.status reverts, dossier deleted, Slack notify', async () => {
    resetMockSlackSends()

    // Configure org with a Slack webhook URL so the notify path runs.
    const db = getServiceClient()
    await db
      .update(orgs)
      .set({ slackWebhookUrl: 'https://hooks.slack.com/mock/profiler-test' })
      .where(eq(orgs.id, PROFILER_ORG_A))

    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    })

    // company_website fails via a blocking orchestrator (Sprint 9 CP2);
    // news fails via failingVercel.scrapeGoogleNews; linkedin via failingApify.
    const failingVercel = new VercelBrowserClient()
    failingVercel.scrapeGoogleNews = async () => {
      throw new Error('VERCEL_AUTH_FAILED: invalid api key')
    }
    const failingApify = new ApifyClient()
    failingApify.scrapeLinkedinProfile = async () => {
      throw new Error('APIFY_AUTH_FAILED: invalid token')
    }
    failingApify.scrapeLinkedinPosts = async () => {
      throw new Error('APIFY_AUTH_FAILED: invalid token')
    }

    // Capture Slack sends via the SlackWebhookClient override.
    const slack = new SlackWebhookClient('https://hooks.slack.com/mock/profiler-test')

    let caught: unknown
    try {
      await processProfilerJob(
        makeJob({ leadId, orgId: PROFILER_ORG_A }),
        makeCtx(PROFILER_ORG_A),
        {
          vercel: failingVercel,
          apify: failingApify,
          browser: blockingBrowser('cloudflare'),
          slack,
          retryBackoffBaseMs: 1,
        },
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId))
    expect(lead?.status).toBe('discovered')

    const dossiers = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    expect(dossiers).toHaveLength(0)

    // Slack notify fired once with Profiler-flavored failure header.
    expect(MOCK_SLACK_SENDS.length).toBeGreaterThanOrEqual(1)
    const profilerSend = MOCK_SLACK_SENDS.find((s) =>
      s.text.includes('Profiler failure'),
    )
    expect(profilerSend).toBeDefined()
  })
})

// ─── 21. Sprint 6b — Synthesis dedupe edge ──────────────────────────

describe('Profiler — synthesis dedupe (Sprint 6b)', () => {
  it('Sarah Series A: 3 sources mention same fact → 1 hook with concatenated evidence', async () => {
    // Drive the worker so we get the curated MOCK_SYNTHESIS_DOSSIERS entry
    // for pulseanalytics.io, which has the Series A hook explicitly dedup'd
    // with cross-source evidence joined by " | ".
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    })

    await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    const db = getServiceClient()
    const [dossier] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    const synthesis = (dossier?.rawSignals as { synthesis?: { hookCandidates?: Array<{ hook: string; evidence: string }> } }).synthesis
    expect(synthesis).toBeDefined()

    // Series A hook present exactly once (raw extractions had it from 3
    // sources; synthesis dedupes).
    const seriesAHooks = synthesis?.hookCandidates?.filter((h) =>
      h.hook.toLowerCase().includes('series a'),
    )
    expect(seriesAHooks?.length).toBe(1)
    // Evidence concatenates all 3 source quotes via the " | " separator
    // documented in PROFILER_SYNTHESIS_PROMPT.
    const seriesAEvidence = seriesAHooks?.[0]?.evidence ?? ''
    expect(seriesAEvidence).toContain('[news]')
    expect(seriesAEvidence).toContain('[linkedin]')
    expect(seriesAEvidence).toContain('[company_website]')
    expect(seriesAEvidence.split(' | ').length).toBeGreaterThanOrEqual(2)
  })
})

// ─── 22. Sprint 6b — evidence_urls populated ────────────────────────

describe('Profiler — evidence_urls populated (Sprint 6b)', () => {
  it('evidence_urls jsonb has entries with hookId/url/sourceType/capturedAt across 3 source types', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    })

    await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    const db = getServiceClient()
    const [dossier] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    const evidenceUrls = dossier?.evidenceUrls as Array<{
      hookId: string
      url: string
      capturedAt: string
      sourceType: 'company_website' | 'linkedin' | 'news'
    }>

    // Each hook above the SCREENSHOT_CONFIDENCE_THRESHOLD (0.7) gets a
    // screenshot. Sarah's curated extractions yield 5 such hooks.
    expect(evidenceUrls.length).toBeGreaterThanOrEqual(3)

    // Each entry shape: uuid hookId, mock-storage URL, ISO capturedAt.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    for (const entry of evidenceUrls) {
      expect(entry.hookId).toMatch(uuidRe)
      expect(entry.url).toContain('mock-storage.spleed.ai')
      expect(entry.url).toContain(`/evidence/${PROFILER_ORG_A}/${leadId}/`)
      expect(entry.url).toContain(`${entry.hookId}-${entry.sourceType}.png`)
      // ISO 8601 — must parse to a valid Date.
      expect(Number.isNaN(new Date(entry.capturedAt).getTime())).toBe(false)
    }

    // All 3 source types represented.
    const sourceTypes = new Set(evidenceUrls.map((e) => e.sourceType))
    expect(sourceTypes).toEqual(new Set(['company_website', 'linkedin', 'news']))
  })
})

// ─── 23. Sprint 6b — Cross-org evidence_urls isolation ──────────────

describe('Profiler — multi-tenant evidence_urls (Sprint 6b)', () => {
  it('Org A evidence_urls invisible from Org B-scoped lead_dossiers query', async () => {
    const leadAId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    })

    await processProfilerJob(
      makeJob({ leadId: leadAId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    const db = getServiceClient()
    // Org A dossier exists with populated evidence_urls.
    const [dossierA] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.orgId, PROFILER_ORG_A))
    expect((dossierA?.evidenceUrls as unknown[]).length).toBeGreaterThan(0)

    // Org B-scoped query returns zero rows — RLS at the lead_dossiers
    // row-level cuts evidence_urls jsonb visibility along with the row.
    const dossiersFromB = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.orgId, PROFILER_ORG_B))
    expect(dossiersFromB).toHaveLength(0)
  })
})

// ─── Sprint 9 CP1/CP2 — phone write-back + browser tier cost_events ───

describe('Profiler — Sprint 9 phone extraction + browser tiers', () => {
  it('extracted phone → leads.phone written; no phone → existing value preserved (no clobber)', async () => {
    // Lead A: andeanfactoring.co company-website fixture carries contactPhone
    // → Profiler normalizes it to E.164 and writes leads.phone.
    const leadWithPhone = await createLead({
      orgId: PROFILER_ORG_B,
      icpId: ICP_PROFILER_FINTECH,
      fullName: 'Camila Restrepo',
      firstName: 'Camila',
      lastName: 'Restrepo',
      company: 'Andean Factoring',
      role: 'CEO',
      companyDomain: 'andeanfactoring.co',
    })
    await processProfilerJob(
      makeJob({ leadId: leadWithPhone, orgId: PROFILER_ORG_B }),
      makeCtx(PROFILER_ORG_B),
    )
    const db = getServiceClient()
    const [a] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadWithPhone))
    expect(a?.status).toBe('enriched')
    expect(a?.phone).toBe('+5715551234') // normalized from '+57 1 555 1234'

    // Lead B: pulseanalytics.io has no contact phone and no LinkedIn source →
    // the worker must NOT clobber a phone already on the row.
    const leadNoPhone = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
    })
    await db.update(leadsTable).set({ phone: '+13334445555' }).where(eq(leadsTable.id, leadNoPhone))
    await processProfilerJob(
      makeJob({ leadId: leadNoPhone, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )
    const [b] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadNoPhone))
    expect(b?.status).toBe('enriched')
    expect(b?.phone).toBe('+13334445555') // preserved — not overwritten with null
  })

  it('browser block → one browser_scrape_<tier> cost_event per attempt (escalation → 2 rows)', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    })
    // blockingBrowser returns 2 attempts (http_direct → vercel_browser, both
    // blocked) — the worker maps attempts[] 1:1 to browser_scrape cost_events.
    await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
      { browser: blockingBrowser('imperva'), retryBackoffBaseMs: 1 },
    )

    const db = getServiceClient()
    // Filter to browser_scrape_* — the news source also writes a vercel_browser
    // row (scrape_news), so scope by operation_type, not provider.
    const allEvents = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.orgId, PROFILER_ORG_A))
    const browserEvents = allEvents.filter((e) => e.operationType.startsWith('browser_scrape_'))

    expect(browserEvents).toHaveLength(2)
    const byTier = new Map(
      browserEvents.map((e) => [(e.metadata as { tier?: string }).tier, e]),
    )
    expect(byTier.has('http_direct')).toBe(true)
    expect(byTier.has('vercel_browser')).toBe(true)
    expect(browserEvents.every((e) => e.operationType.startsWith('browser_scrape_'))).toBe(true)
    expect(browserEvents.every((e) => e.success === false)).toBe(true)
    // The escalated (2nd) attempt links back to the tier that bounced it.
    expect((byTier.get('vercel_browser')?.metadata as { escalated_from?: string }).escalated_from).toBe(
      'http_direct',
    )
  })
})

// ─── 30. Sprint 7c — concierge ingest_source tracking ───────────────

describe('processConciergeJob — Sprint 7c ingest_source tracking', () => {
  it("tags ingest_source='slack_concierge' + writes a concierge_parse cost_event", async () => {
    const slack = new SlackClient({ token: 'xoxb-test', mockMode: true })
    const anthropic = new AnthropicClient({ apiKey: 'mock', mockMode: true })

    const result = await processConciergeJob(
      {
        data: {
          orgId: PROFILER_ORG_A,
          slackChannelId: 'D_TEST',
          slackUserId: 'U_TEST',
          slackThreadTs: '1700000000.0007',
          text: 'who is Sarah Chen from PulseAnalytics',
        },
      },
      makeCtx(PROFILER_ORG_A),
      { slack, anthropic },
    )

    // PROFILER_ORG_A has ICPs but none is default → the new lead is parked
    // (no Profiler enqueue, so no Redis needed here). What we assert is the
    // ingest_source tag + the concierge_parse cost_event.
    expect(result.parseSucceeded).toBe(true)
    expect(result.status).toBe('parked_no_icp')

    const db = getServiceClient()
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.orgId, PROFILER_ORG_A),
          eq(leadsTable.companyDomain, 'pulseanalytics.com'),
        ),
      )
    expect(lead?.ingestSource).toBe('slack_concierge')
    expect(lead?.fullName).toBe('Sarah Chen')
    expect(lead?.foundVia).toBe('manual_ingest')

    // concierge_parse cost_event written (in addition to the standard Profiler
    // costs a non-parked lead would later accrue downstream).
    const parseEvents = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.orgId, PROFILER_ORG_A),
          eq(costEvents.agentType, 'concierge'),
          eq(costEvents.operationType, 'concierge_parse'),
        ),
      )
    expect(parseEvents).toHaveLength(1)
    expect(parseEvents[0]?.provider).toBe('anthropic')
    expect(parseEvents[0]?.success).toBe(true)
  })
})

// ─── 24. Sprint 6b — Apify mock determinism ─────────────────────────

describe('ApifyClient — mock determinism (Sprint 6b)', () => {
  it('same LinkedIn URL → identical profile + posts payload across calls', async () => {
    const apify = new ApifyClient()
    const url = 'https://linkedin.com/in/sarahchen'

    const p1 = await apify.scrapeLinkedinProfile(url)
    const p2 = await apify.scrapeLinkedinProfile(url)
    expect(p1.profile.fullName).toBe(p2.profile.fullName)
    expect(p1.profile.headline).toBe(p2.profile.headline)
    expect(p1.profile.experience).toEqual(p2.profile.experience)
    expect(p1.profile.skills).toEqual(p2.profile.skills)
    expect(p1.metadata.profileUrl).toBe(p2.metadata.profileUrl)
    expect(p1.costUsd).toBe(p2.costUsd)

    const posts1 = await apify.scrapeLinkedinPosts(url, { limit: 5 })
    const posts2 = await apify.scrapeLinkedinPosts(url, { limit: 5 })
    expect(posts1.posts.length).toBe(posts2.posts.length)
    expect(posts1.posts[0]?.id).toBe(posts2.posts[0]?.id)
    expect(posts1.posts[0]?.content).toBe(posts2.posts[0]?.content)
    expect(posts1.costUsd).toBe(posts2.costUsd)
  })
})

// ─── 25-29. Sprint 7b — Phase 7/8 deep research integration ─────────

describe('processProfilerJob — Sprint 7b deep research (Phase 7/8)', () => {
  it('Phase 7 triggers when Phase 6 confidence < 0.75 (examplelender → deep research fires)', async () => {
    // examplelender.com is NOT in the Sprint 6b synthesis curated map →
    // Phase 6 falls back to confidence 0.4 (< 0.75 threshold). It IS in
    // MOCK_DEEP_RESEARCH_DOSSIERS → deep research surfaces findings.
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Jorge Martinez',
      firstName: 'Jorge',
      lastName: 'Martinez',
      company: 'Example Lender',
      role: 'CEO',
      companyDomain: 'examplelender.com',
      linkedinUrl: 'https://linkedin.com/in/example-ceo',
    })

    const result = await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    expect(result.status).toBe('enriched')
    expect(result.phase7Triggered).toBe(true)
    expect(result.phase7Failed).toBe(false)
    expect(result.phase8Ran).toBe(true)

    const db = getServiceClient()
    const [dossier] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    expect(dossier?.enrichedBy).toBe('profiler_agent_v3')
    const raw = dossier?.rawSignals as {
      phase7Triggered?: boolean
      phase8Ran?: boolean
      deepResearchSignals?: unknown
      initialConfidence?: number
      finalConfidence?: number
    }
    expect(raw.phase7Triggered).toBe(true)
    expect(raw.phase8Ran).toBe(true)
    expect(raw.deepResearchSignals).not.toBeNull()
    // Deep research boosted confidence: initial 0.4 → final 0.95 (3 sources + findings).
    expect(raw.initialConfidence).toBeLessThan(0.75)
    expect(raw.finalConfidence).toBe(0.95)
  })

  it('Phase 7 skips when Phase 6 confidence >= 0.75 (Sarah pulseanalytics → 8 cost_events baseline)', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Sarah Chen',
      firstName: 'Sarah',
      lastName: 'Chen',
      company: 'Pulse Analytics',
      role: 'Founder',
      companyDomain: 'pulseanalytics.io',
      linkedinUrl: 'https://linkedin.com/in/sarahchen',
    })

    const result = await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    expect(result.status).toBe('enriched')
    // pulseanalytics Phase 6 synthesis confidence 0.88 ≥ 0.75 → skip.
    expect(result.phase7Triggered).toBe(false)
    expect(result.phase7Failed).toBe(false)
    expect(result.phase8Ran).toBe(false)

    const db = getServiceClient()
    const [dossier] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    // enrichedBy is v3 even when Phase 7 skips (Sprint 7b worker version).
    expect(dossier?.enrichedBy).toBe('profiler_agent_v3')
    const raw = dossier?.rawSignals as { deepResearchSignals?: unknown }
    expect(raw.deepResearchSignals).toBeNull()

    // 8 cost_events — Sprint 6b baseline, no Phase 7/8 rows.
    const events = await db
      .select()
      .from(costEvents)
      .where(
        and(eq(costEvents.orgId, PROFILER_ORG_A), eq(costEvents.agentType, 'profiler')),
      )
    expect(events).toHaveLength(8)
  })

  it('Phase 7 graceful fail (deep research throws) → fallback to Phase 6, phase7Failed=true', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Jorge Martinez',
      firstName: 'Jorge',
      lastName: 'Martinez',
      company: 'Example Lender',
      role: 'CEO',
      companyDomain: 'examplelender.com',
      linkedinUrl: 'https://linkedin.com/in/example-ceo',
    })

    // Inject a DeepResearchAgent whose research() throws — simulates an
    // Opus quota error. classifyError buckets 'quota' → permanent → no
    // retry, Phase 7 catch fires.
    const failingAgent = new DeepResearchAgent({
      anthropicClient: new AnthropicClient({ apiKey: 'mock' }),
      apifyClient: new ApifyClient(),
      vercelBrowserClient: new VercelBrowserClient(),
    })
    failingAgent.research = async () => {
      throw new Error('ANTHROPIC_QUOTA_EXHAUSTED: Opus deep research budget hit')
    }

    const result = await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
      { deepResearchAgent: failingAgent, retryBackoffBaseMs: 1 },
    )

    // Still completes — Phase 6 synthesis becomes the final dossier.
    expect(result.status).toBe('enriched')
    expect(result.phase7Triggered).toBe(true)
    expect(result.phase7Failed).toBe(true)
    expect(result.phase8Ran).toBe(false)

    const db = getServiceClient()
    const [dossier] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.leadId, leadId))
    const raw = dossier?.rawSignals as {
      phase7Failed?: boolean
      deepResearchSignals?: unknown
      initialConfidence?: number
      finalConfidence?: number
    }
    expect(raw.phase7Failed).toBe(true)
    expect(raw.deepResearchSignals).toBeNull()
    // Fallback: final confidence == initial (no Phase 8 lift).
    expect(raw.finalConfidence).toBe(raw.initialConfidence)

    // A failed deep_research_llm cost_event was recorded (success=false).
    const failedEvents = await db
      .select()
      .from(costEvents)
      .where(
        and(
          eq(costEvents.orgId, PROFILER_ORG_A),
          eq(costEvents.operationType, 'deep_research_llm'),
          eq(costEvents.success, false),
        ),
      )
    expect(failedEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('cost_events granular: full Phase 7/8 enrichment writes 13 rows', async () => {
    const leadId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Jorge Martinez',
      firstName: 'Jorge',
      lastName: 'Martinez',
      company: 'Example Lender',
      role: 'CEO',
      companyDomain: 'examplelender.com',
      linkedinUrl: 'https://linkedin.com/in/example-ceo',
    })

    await processProfilerJob(
      makeJob({ leadId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    const db = getServiceClient()
    const events = await db
      .select()
      .from(costEvents)
      .where(
        and(eq(costEvents.orgId, PROFILER_ORG_A), eq(costEvents.agentType, 'profiler')),
      )
    // 8 Sprint 6b baseline + 4 Phase 7 (llm + web_search + web_fetch + custom) + 1 Phase 8.
    expect(events).toHaveLength(13)

    const opTypes = new Set(events.map((e) => e.operationType))
    expect(opTypes).toContain('deep_research_llm')
    expect(opTypes).toContain('deep_research_web_search')
    expect(opTypes).toContain('deep_research_web_fetch')
    expect(opTypes).toContain('deep_research_custom_tool')
    expect(opTypes).toContain('synthesis_final')

    // web_search cost_event carries the count in metadata.
    const webSearch = events.find((e) => e.operationType === 'deep_research_web_search')
    expect((webSearch?.metadata as { count?: number })?.count).toBe(12)
    // Custom tool routed to Apify (LinkedIn).
    const customTool = events.find((e) => e.operationType === 'deep_research_custom_tool')
    expect(customTool?.provider).toBe('apify')
  })

  it('multi-tenant: Org A deep research dossier invisible from Org B query', async () => {
    const leadAId = await createLead({
      orgId: PROFILER_ORG_A,
      icpId: ICP_PROFILER_SAAS,
      fullName: 'Jorge Martinez',
      firstName: 'Jorge',
      lastName: 'Martinez',
      company: 'Example Lender',
      role: 'CEO',
      companyDomain: 'examplelender.com',
      linkedinUrl: 'https://linkedin.com/in/example-ceo',
    })

    await processProfilerJob(
      makeJob({ leadId: leadAId, orgId: PROFILER_ORG_A }),
      makeCtx(PROFILER_ORG_A),
    )

    const db = getServiceClient()
    // Org A dossier carries deep research signals.
    const [dossierA] = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.orgId, PROFILER_ORG_A))
    expect((dossierA?.rawSignals as { deepResearchSignals?: unknown }).deepResearchSignals).not.toBeNull()

    // Org B-scoped query → zero rows. Deep research data inherits the
    // lead_dossiers row-level RLS contract.
    const dossiersFromB = await db
      .select()
      .from(leadDossiersTable)
      .where(eq(leadDossiersTable.orgId, PROFILER_ORG_B))
    expect(dossiersFromB).toHaveLength(0)
  })
})
