import { sql } from 'drizzle-orm'
import { getServiceClient } from '../client'
import {
  assets,
  icps,
  leadDossiers,
  leadThreads,
  leads,
  orgMembers,
  orgs,
  outreachEvents,
  toolCallLogs,
  trackingEvents,
  users,
} from '../schema'

export const ORG_A_ID = '00000000-0000-0000-0000-00000000000a'
export const ORG_B_ID = '00000000-0000-0000-0000-00000000000b'
export const USER_A_ID = '11111111-1111-1111-1111-1111111111aa'
export const USER_B_ID = '11111111-1111-1111-1111-1111111111bb'
export const USER_A_AUTH_ID = '00000000-0000-0000-0000-0000000000a1'
export const USER_B_AUTH_ID = '00000000-0000-0000-0000-0000000000b1'

// Sprint 2 fixtures
export const ICP_A_ID = '22222222-2222-2222-2222-22222222222a'
export const ICP_B_ID = '22222222-2222-2222-2222-22222222222b'
export const LEAD_A_ID = '33333333-3333-3333-3333-33333333333a'
export const LEAD_B_ID = '33333333-3333-3333-3333-33333333333b'

// Sprint 4 fixtures
export const ASSET_A_ID = '44444444-4444-4444-4444-44444444444a'
export const ASSET_B_ID = '44444444-4444-4444-4444-44444444444b'
export const OUTREACH_A_ID = '55555555-5555-5555-5555-55555555555a'
export const OUTREACH_B_ID = '55555555-5555-5555-5555-55555555555b'
export const TRACKING_A_ID = '66666666-6666-6666-6666-66666666666a'
export const TRACKING_B_ID = '66666666-6666-6666-6666-66666666666b'

/**
 * Wipe all org/user data. CASCADE handles every dependent table including
 * Sprint 2 additions (icps, leads, lead_dossiers, lead_threads).
 */
export async function resetTestData(): Promise<void> {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
}

/**
 * Seed the canonical isolation fixture: 2 orgs, 2 users, 2 owner memberships.
 * Called from beforeAll() in isolation tests.
 */
export async function seedIsolationFixtures(): Promise<void> {
  await resetTestData()
  const db = getServiceClient()

  await db.insert(orgs).values([
    { id: ORG_A_ID, name: 'Org A', slug: 'org-a' },
    { id: ORG_B_ID, name: 'Org B', slug: 'org-b' },
  ])

  await db.insert(users).values([
    {
      id: USER_A_ID,
      supabaseAuthId: USER_A_AUTH_ID,
      email: 'a@test.spleed.ai',
      name: 'User A',
    },
    {
      id: USER_B_ID,
      supabaseAuthId: USER_B_AUTH_ID,
      email: 'b@test.spleed.ai',
      name: 'User B',
    },
  ])

  await db.insert(orgMembers).values([
    { orgId: ORG_A_ID, userId: USER_A_ID, role: 'owner' },
    { orgId: ORG_B_ID, userId: USER_B_ID, role: 'owner' },
  ])
}

/**
 * Sprint 2 pipeline fixtures: one ICP, one lead, one dossier, one thread per org.
 * Call AFTER seedIsolationFixtures().
 */
export async function seedLeadFixtures(): Promise<void> {
  const db = getServiceClient()

  await db.insert(icps).values([
    {
      id: ICP_A_ID,
      orgId: ORG_A_ID,
      name: 'Series A SaaS CTOs',
      definitionNaturalLanguage:
        'Technical co-founders of B2B SaaS at Series A, US-based, 20-200 employees.',
      parsedFilters: {
        version: '1',
        titles: ['CTO', 'VP Engineering'],
        industries: ['SaaS'],
      },
    },
    {
      id: ICP_B_ID,
      orgId: ORG_B_ID,
      name: 'Fintech CFOs',
      definitionNaturalLanguage: 'CFOs at Series B fintech startups in North America.',
      parsedFilters: {
        version: '1',
        titles: ['CFO'],
        industries: ['Fintech'],
      },
    },
  ])

  await db.insert(leads).values([
    {
      id: LEAD_A_ID,
      orgId: ORG_A_ID,
      icpId: ICP_A_ID,
      fullName: 'Alice CTO',
      firstName: 'Alice',
      lastName: 'CTO',
      company: 'AcmeA',
      role: 'CTO',
      email: 'alice@acmea.com',
      foundVia: 'apollo',
      fitScore: 0.9,
      fitReasoning: 'Matches title + industry, recent Series A funding.',
      fitScoreComputedAt: new Date(),
    },
    {
      id: LEAD_B_ID,
      orgId: ORG_B_ID,
      icpId: ICP_B_ID,
      fullName: 'Bob CFO',
      firstName: 'Bob',
      lastName: 'CFO',
      company: 'AcmeB',
      role: 'CFO',
      email: 'bob@acmeb.com',
      foundVia: 'apollo',
      fitScore: 0.85,
      fitReasoning: 'CFO at Series B fintech.',
      fitScoreComputedAt: new Date(),
    },
  ])

  await db.insert(leadDossiers).values([
    { leadId: LEAD_A_ID, orgId: ORG_A_ID, confidenceScore: 0.8 },
    { leadId: LEAD_B_ID, orgId: ORG_B_ID, confidenceScore: 0.75 },
  ])

  await db.insert(leadThreads).values([
    {
      leadId: LEAD_A_ID,
      orgId: ORG_A_ID,
      role: 'agent',
      agentKind: 'scout',
      content: 'Discovered Alice via Apollo.',
    },
    {
      leadId: LEAD_B_ID,
      orgId: ORG_B_ID,
      role: 'agent',
      agentKind: 'scout',
      content: 'Discovered Bob via Apollo.',
    },
  ])
}

/**
 * Sprint 4 fixtures: one asset per org. Call AFTER seedLeadFixtures().
 */
export async function seedAssetFixtures(): Promise<void> {
  const db = getServiceClient()
  await db.insert(assets).values([
    {
      id: ASSET_A_ID,
      orgId: ORG_A_ID,
      leadId: LEAD_A_ID,
      kind: 'microsite',
      slug: 'alice-cto-fixture-a',
      content: { version: '1', kind: 'microsite', hero: { h1: 'Fixture A', subhead: 'For testing' } },
      publicUrl: 'https://lead.spleed.ai/alice-cto-fixture-a',
      preferredOutreachMessage: 'fixture outreach a',
    },
    {
      id: ASSET_B_ID,
      orgId: ORG_B_ID,
      leadId: LEAD_B_ID,
      kind: 'microsite',
      slug: 'bob-cfo-fixture-b',
      content: { version: '1', kind: 'microsite', hero: { h1: 'Fixture B', subhead: 'For testing' } },
      publicUrl: 'https://lead.spleed.ai/bob-cfo-fixture-b',
      preferredOutreachMessage: 'fixture outreach b',
    },
  ])
}

/**
 * Sprint 4 fixtures: one outbound outreach_event per org. Call AFTER seedAssetFixtures().
 */
export async function seedOutreachEventFixtures(): Promise<void> {
  const db = getServiceClient()
  await db.insert(outreachEvents).values([
    {
      id: OUTREACH_A_ID,
      orgId: ORG_A_ID,
      leadId: LEAD_A_ID,
      assetId: ASSET_A_ID,
      channel: 'email',
      direction: 'outbound',
      subject: 'Fixture outreach to Alice',
      content: 'Hello Alice, this is a fixture outreach.',
      providerMessageId: 'fixture-provider-a-1',
      status: 'sent',
      sequencePosition: 1,
      sentAt: new Date(),
    },
    {
      id: OUTREACH_B_ID,
      orgId: ORG_B_ID,
      leadId: LEAD_B_ID,
      assetId: ASSET_B_ID,
      channel: 'linkedin',
      direction: 'outbound',
      content: 'Hello Bob, this is a fixture outreach.',
      providerMessageId: 'fixture-provider-b-1',
      status: 'sent',
      sequencePosition: 1,
      sentAt: new Date(),
    },
  ])
}

/**
 * Sprint 4 fixtures: one page_view tracking_event per org. Call AFTER seedAssetFixtures().
 */
export async function seedTrackingEventFixtures(): Promise<void> {
  const db = getServiceClient()
  await db.insert(trackingEvents).values([
    {
      id: TRACKING_A_ID,
      orgId: ORG_A_ID,
      assetId: ASSET_A_ID,
      leadId: LEAD_A_ID,
      kind: 'page_view',
      sessionFingerprint: 'fixture-fingerprint-a-1',
      referrer: 'https://mail.google.com',
      metadata: { viewport: '1440x900' },
    },
    {
      id: TRACKING_B_ID,
      orgId: ORG_B_ID,
      assetId: ASSET_B_ID,
      leadId: LEAD_B_ID,
      kind: 'page_view',
      sessionFingerprint: 'fixture-fingerprint-b-1',
      referrer: 'https://linkedin.com',
      metadata: { viewport: '1920x1080' },
    },
  ])
}

/**
 * Sprint 3 fixtures: one tool_call_log per org (proves RLS scoping for the new table).
 * Call AFTER seedIsolationFixtures().
 */
export async function seedToolCallLogFixtures(): Promise<void> {
  const db = getServiceClient()
  await db.insert(toolCallLogs).values([
    {
      orgId: ORG_A_ID,
      agentKind: 'scout',
      toolName: 'hello_world',
      inputJson: { message: 'fixture-a' },
      outputJson: { echo: 'scout says: fixture-a' },
      success: true,
      durationMs: 12,
    },
    {
      orgId: ORG_B_ID,
      agentKind: 'scout',
      toolName: 'hello_world',
      inputJson: { message: 'fixture-b' },
      outputJson: { echo: 'scout says: fixture-b' },
      success: true,
      durationMs: 15,
    },
  ])
}
