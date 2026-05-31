/**
 * Composer test suite (Sprint 8.2 — 6 tests).
 *
 * Drives processComposerJob against the DB (mock Anthropic, no Slack thread)
 * + a couple of direct ComposerAgent unit checks. Mirrors profiler.test.ts:
 * direct processor invocation with a synthetic ctx, no Redis.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
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
  outreachDrafts as outreachDraftsTable,
  users,
} from '@spleed/db'
import { AnthropicClient } from '@spleed/integrations/anthropic'
import { ComposerAgent, type ComposerInput } from '../agents/composer'
import { createScopedDb, type WorkerContext } from '../workers/context'
import { processComposerJob } from '../workers/composer.worker'

const ORG = 'c0000000-0000-4000-8000-000000000001'
const USER = 'c0000000-0000-4000-8000-000000000002'
const USER_AUTH = 'c0000000-0000-4000-8000-000000000003'
const ICP = 'c0000000-0000-4000-8000-000000000004'
const LEAD = 'c0000000-0000-4000-8000-000000000005'

const silentLogger = pino({ level: 'silent' })
function makeCtx(): WorkerContext {
  return { orgId: ORG, jobId: 'composer-test', traceId: 'composer-test', attemptsMade: 0, logger: silentLogger, db: createScopedDb(ORG) }
}

const anthropic = new AnthropicClient({ apiKey: 'mock', mockMode: true })

beforeAll(async () => {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await db.insert(orgs).values({ id: ORG, name: 'Composer Org', slug: 'composer-org' })
  await db.insert(users).values({ id: USER, supabaseAuthId: USER_AUTH, email: 'c@composer.test', name: 'C' })
  await db.insert(orgMembers).values({ orgId: ORG, userId: USER, role: 'owner' })
  await db.insert(icpsTable).values({
    id: ICP, orgId: ORG, name: 'SaaS founders', definitionNaturalLanguage: 'B2B SaaS founders US.',
    parsedFilters: { version: '1', industries: ['saas'] }, isDefault: true, preferredChannel: 'email',
    outreachVoiceGuidance: 'Direct, founder-to-founder. Reference a specific recent signal.',
    outreachFooterTemplate: '{{company}} · Unsubscribe · {{sender_name}}',
  })
  await db.insert(leadsTable).values({
    id: LEAD, orgId: ORG, icpId: ICP, status: 'enriched',
    fullName: 'Sarah Chen', company: 'Pulse Analytics', role: 'Founder & CEO',
    companyDomain: 'pulseanalytics.io', email: 'sarah@pulseanalytics.io',
    linkedinUrl: 'https://linkedin.com/in/sarahchen', foundVia: 'test', ingestSource: 'manual_url',
  })
  await db.insert(leadDossiersTable).values({
    leadId: LEAD, orgId: ORG, enrichedBy: 'profiler_agent_v3', confidenceScore: 0.95,
    rawSignals: {
      synthesis: {
        recommendedAngle: 'Tie the Series A to the CSO hire.', painInferred: 'Scaling outbound.',
        confidenceScore: 0.95,
        hookCandidates: [{ hook: 'Closed $14M Series A', evidence: 'TechCrunch', sourceName: 'news', confidence: 0.93 }],
      },
      deepResearchSignals: { recommended_hooks: [{ hook: 'Brian Chen CSO', evidence: 'succession', confidence: 0.9 }] },
    },
  })
})

afterAll(async () => {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await closeServiceClient()
})

beforeEach(async () => {
  const db = getServiceClient()
  await db.delete(outreachDraftsTable).where(eq(outreachDraftsTable.orgId, ORG))
  await db.delete(costEvents).where(eq(costEvents.orgId, ORG))
})

describe('processComposerJob — Sprint 8.2', () => {
  it('happy path Sarah → drafted (pending_approval) email draft', async () => {
    const result = await processComposerJob({ data: { orgId: ORG, leadId: LEAD, mode: 'initial' } }, makeCtx())
    expect(result.status).toBe('drafted')
    expect(result.costUsd).toBeGreaterThan(0)

    const db = getServiceClient()
    const [draft] = await db.select().from(outreachDraftsTable).where(eq(outreachDraftsTable.id, result.draftId!))
    expect(draft?.status).toBe('pending_approval')
    expect(draft?.channel).toBe('email') // Phase 0: ICP email default + email present
    expect(draft?.subject).toContain('Series A') // hook lands in the subject
    expect(draft?.body).toContain('Costanoa') // $14M raise referenced in the body
    expect(draft?.enrichedBy).toBe('composer_agent_v1')
  })

  it('voice guidance flows into composer_metadata.voiceApplied', async () => {
    const result = await processComposerJob({ data: { orgId: ORG, leadId: LEAD } }, makeCtx())
    const db = getServiceClient()
    const [draft] = await db.select().from(outreachDraftsTable).where(eq(outreachDraftsTable.id, result.draftId!))
    const meta = draft?.composerMetadata as { voiceApplied?: string; contactData?: { email?: string } }
    expect(meta.voiceApplied).toBe('Direct, founder-to-founder. Reference a specific recent signal.')
    expect(meta.contactData?.email).toBe('sarah@pulseanalytics.io')
  })

  it('Hermes ICP starter — education description → formal Spanish voice + footer', async () => {
    const r = await new ComposerAgent({ anthropicClient: anthropic }).generateIcpStarterGuidance({
      icpId: ICP,
      icpDescription: 'Heads of bilingual private schools in Colombia.',
      icpIndustry: 'education',
      anthropicClient: anthropic,
    })
    expect(r.guidance.voiceGuidance.toLowerCase()).toMatch(/usted|formal/)
    expect(r.guidance.footerTemplate).toContain('{{company}}')
    expect(r.costUsd).toBeGreaterThan(0)
  })

  it('quality gate failure → compose() returns failed_quality (no throw)', async () => {
    const input: ComposerInput = {
      lead: { fullName: 'Sarah Chen', company: 'Pulse Analytics', role: 'Founder', companyDomain: 'pulseanalytics.io', email: 'sarah@pulseanalytics.io' },
      icp: { name: 'SaaS', definitionNaturalLanguage: 'SaaS founders.', preferredChannel: 'email', voiceGuidance: null, footerTemplate: null },
      dossier: { recommendedAngle: 'angle', confidenceScore: 0.9, hookCandidates: [], deepResearchHooks: [] },
      anthropicClient: anthropic,
    }
    // Inject a quality checker that fails (missing unsubscribe marker).
    const agent = new ComposerAgent({
      anthropicClient: anthropic,
      qualityChecker: async () => ({
        verdict: { passed: false, issues: ['missing unsubscribe mechanism'], markersFound: [] },
        tokensIn: 1000, tokensOut: 300, costUsd: 0.005, latencyMs: 100,
      }),
    })
    const out = await agent.compose(input)
    expect(out.status).toBe('failed_quality')
    if (out.status === 'failed_quality') {
      expect(out.qualityVerdict.passed).toBe(false)
      expect(out.qualityVerdict.issues[0]).toContain('unsubscribe')
    }
  })

  it('regenerate → new draft inserted + original marked regenerated', async () => {
    const first = await processComposerJob({ data: { orgId: ORG, leadId: LEAD, mode: 'initial' } }, makeCtx())
    const second = await processComposerJob(
      { data: { orgId: ORG, leadId: LEAD, mode: 'regenerate', supersedesDraftId: first.draftId } },
      makeCtx(),
    )
    expect(second.status).toBe('drafted')
    expect(second.draftId).not.toBe(first.draftId)

    const db = getServiceClient()
    const [original] = await db.select().from(outreachDraftsTable).where(eq(outreachDraftsTable.id, first.draftId!))
    const [regen] = await db.select().from(outreachDraftsTable).where(eq(outreachDraftsTable.id, second.draftId!))
    expect(original?.status).toBe('regenerated')
    expect(regen?.status).toBe('pending_approval')
  })

  it('cost_events: 5 granular composer rows per draft', async () => {
    await processComposerJob({ data: { orgId: ORG, leadId: LEAD } }, makeCtx())
    const db = getServiceClient()
    const events = await db
      .select()
      .from(costEvents)
      .where(and(eq(costEvents.orgId, ORG), eq(costEvents.agentType, 'composer')))
    expect(events).toHaveLength(5)
    const ops = new Set(events.map((e) => e.operationType))
    expect(ops).toEqual(
      new Set([
        'composer_channel_recommendation',
        'composer_hook_selection',
        'composer_angle_generation',
        'composer_draft_composition',
        'composer_quality_check',
      ]),
    )
  })
})

// ─── Sprint 9 CP1 — Composer Phase 0 channel resolution with lead.phone ─

const ICP_IM = 'c0000000-0000-4000-8000-0000000000a1'
const LEAD_PHONE = 'c0000000-0000-4000-8000-0000000000a2'
const LEAD_NOCONTACT = 'c0000000-0000-4000-8000-0000000000a3'

describe('processComposerJob — Phase 0 channel (Sprint 9 phone)', () => {
  async function seedDossier(leadId: string): Promise<void> {
    const db = getServiceClient()
    await db.insert(leadDossiersTable).values({
      leadId, orgId: ORG, enrichedBy: 'profiler_agent_v3', confidenceScore: 0.9,
      rawSignals: {
        synthesis: {
          recommendedAngle: 'Tie outreach to recent growth signal.', painInferred: 'Manual outbound.',
          confidenceScore: 0.9,
          hookCandidates: [{ hook: 'Recent expansion', evidence: 'Press', sourceName: 'news', confidence: 0.9 }],
        },
      },
    })
  }

  it('ICP prefers iMessage + lead.phone present → draft.channel=imessage', async () => {
    const db = getServiceClient()
    await db.insert(icpsTable).values({
      id: ICP_IM, orgId: ORG, name: 'iMessage ICP', definitionNaturalLanguage: 'Founders reachable by text.',
      parsedFilters: { version: '1', industries: ['saas'] }, isDefault: false, preferredChannel: 'imessage',
      outreachVoiceGuidance: 'Direct, founder-to-founder.', outreachFooterTemplate: '{{company}} · Unsubscribe',
    })
    await db.insert(leadsTable).values({
      id: LEAD_PHONE, orgId: ORG, icpId: ICP_IM, status: 'enriched',
      fullName: 'Diego Vargas', company: 'Vargas Co', role: 'Founder',
      companyDomain: 'vargas.co', phone: '+13334445555', foundVia: 'test', ingestSource: 'manual_url',
    })
    await seedDossier(LEAD_PHONE)

    const result = await processComposerJob({ data: { orgId: ORG, leadId: LEAD_PHONE, mode: 'initial' } }, makeCtx())
    expect(result.status).toBe('drafted')
    const [draft] = await db.select().from(outreachDraftsTable).where(eq(outreachDraftsTable.id, result.draftId!))
    expect(draft?.channel).toBe('imessage') // ICP imessage + phone on file → Phase 0 routes iMessage
  })

  it('no email + no phone → manual lookup (no_contact, no draft)', async () => {
    const db = getServiceClient()
    await db.insert(leadsTable).values({
      id: LEAD_NOCONTACT, orgId: ORG, icpId: ICP, status: 'enriched',
      fullName: 'Ghost Lead', company: 'Nowhere Inc', role: 'Founder',
      companyDomain: 'nowhere.co', email: null, phone: null, foundVia: 'test', ingestSource: 'manual_url',
    })
    await seedDossier(LEAD_NOCONTACT)

    const result = await processComposerJob({ data: { orgId: ORG, leadId: LEAD_NOCONTACT, mode: 'initial' } }, makeCtx())
    expect(result.status).toBe('no_contact')
    expect(result.draftId).toBeUndefined()
  })
})
