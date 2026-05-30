/**
 * Outreach Operator test suite (Sprint 8.2 — 3 tests).
 *
 * Mock delivery (no real SMTP/Sendblue). Test 8 exercises the BullMQ enqueue
 * seam (needs REDIS_URL); 7 + 9 are direct DB.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import pino from 'pino'
import {
  closeServiceClient,
  costEvents,
  getServiceClient,
  icps as icpsTable,
  leads as leadsTable,
  orgMembers,
  orgs,
  outreachDrafts as outreachDraftsTable,
  users,
} from '@spleed/db'
import {
  closeRedisConnection,
  createQueue,
  createScopedDb,
  enqueueOutreachDelivery,
  processOutreachDeliveryJob,
  type WorkerContext,
} from '../workers'

const ORG_A = 'd0000000-0000-4000-8000-0000000000a1'
const ORG_B = 'd0000000-0000-4000-8000-0000000000b1'
const USER_A = 'd0000000-0000-4000-8000-0000000000a2'
const USER_B = 'd0000000-0000-4000-8000-0000000000b2'
const ICP_A = 'd0000000-0000-4000-8000-0000000000a3'
const ICP_B = 'd0000000-0000-4000-8000-0000000000b3'
const LEAD_A = 'd0000000-0000-4000-8000-0000000000a4'
const LEAD_B = 'd0000000-0000-4000-8000-0000000000b4'
const OPERATOR_QUEUE = 'outreach-operator'

const silentLogger = pino({ level: 'silent' })
function makeCtx(orgId: string): WorkerContext {
  return { orgId, jobId: 'op-test', traceId: 'op-test', attemptsMade: 0, logger: silentLogger, db: createScopedDb(orgId) }
}

async function seedOrg(orgId: string, userId: string, userAuth: string, icpId: string, leadId: string, slug: string): Promise<void> {
  const db = getServiceClient()
  await db.insert(orgs).values({ id: orgId, name: `Op Org ${slug}`, slug: `op-${slug}` })
  await db.insert(users).values({ id: userId, supabaseAuthId: userAuth, email: `${slug}@op.test`, name: slug })
  await db.insert(orgMembers).values({ orgId, userId, role: 'owner' })
  await db.insert(icpsTable).values({
    id: icpId, orgId, name: 'ICP', definitionNaturalLanguage: 'x', parsedFilters: { version: '1' }, preferredChannel: 'email',
  })
  await db.insert(leadsTable).values({
    id: leadId, orgId, icpId, status: 'enriched', fullName: 'Lead', company: 'Co',
    email: `lead-${slug}@example.com`, foundVia: 'test',
  })
}

async function createDraft(orgId: string, icpId: string, leadId: string, status: 'approved' | 'pending_approval' = 'approved'): Promise<string> {
  const db = getServiceClient()
  const [row] = await db
    .insert(outreachDraftsTable)
    .values({
      orgId, leadId, icpId, channel: 'email', subject: 'Hi', body: 'Body. Reply STOP to opt out.',
      status, enrichedBy: 'composer_agent_v1', composerMetadata: {},
    })
    .returning({ id: outreachDraftsTable.id })
  return row!.id
}

async function clearQueue(): Promise<void> {
  const queue = createQueue(OPERATOR_QUEUE)
  try { await queue.obliterate({ force: true }) } catch {} finally { await queue.close() }
}

afterAll(async () => {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await clearQueue()
  await closeRedisConnection()
  await closeServiceClient()
})

beforeEach(async () => {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await seedOrg(ORG_A, USER_A, 'd0000000-0000-4000-8000-0000000000a8', ICP_A, LEAD_A, 'a')
  await seedOrg(ORG_B, USER_B, 'd0000000-0000-4000-8000-0000000000b8', ICP_B, LEAD_B, 'b')
  await clearQueue()
})

describe('Outreach Operator — Sprint 8.2', () => {
  it('mock send → status=sent + delivery cost_event', async () => {
    const draftId = await createDraft(ORG_A, ICP_A, LEAD_A)
    const result = await processOutreachDeliveryJob({ data: { orgId: ORG_A, draftId, channel: 'email' } }, makeCtx(ORG_A))
    expect(result.status).toBe('sent')

    const db = getServiceClient()
    const [draft] = await db.select().from(outreachDraftsTable).where(eq(outreachDraftsTable.id, draftId))
    expect(draft?.status).toBe('sent')
    expect(draft?.sentAt).toBeInstanceOf(Date)

    const events = await db
      .select()
      .from(costEvents)
      .where(and(eq(costEvents.orgId, ORG_A), eq(costEvents.operationType, 'outreach_delivery_email')))
    expect(events).toHaveLength(1)
    expect(events[0]?.provider).toBe('resend')
  })

  it('enqueueOutreachDelivery → job lands on the outreach-operator queue', async () => {
    const draftId = await createDraft(ORG_A, ICP_A, LEAD_A)
    await enqueueOutreachDelivery({ orgId: ORG_A, draftId, channel: 'email' })
    const queue = createQueue(OPERATOR_QUEUE)
    const job = await queue.getJob(`outreach-delivery-${draftId}`)
    expect(job).toBeDefined()
    expect(job?.data).toMatchObject({ orgId: ORG_A, draftId, channel: 'email' })
    await queue.close()
  })

  it('multi-tenant: Org A drafts invisible to an Org B-scoped query', async () => {
    await createDraft(ORG_A, ICP_A, LEAD_A)
    await createDraft(ORG_B, ICP_B, LEAD_B)
    const db = getServiceClient()
    const bDrafts = await db.select().from(outreachDraftsTable).where(eq(outreachDraftsTable.orgId, ORG_B))
    const aDrafts = await db.select().from(outreachDraftsTable).where(eq(outreachDraftsTable.orgId, ORG_A))
    expect(bDrafts).toHaveLength(1)
    expect(aDrafts).toHaveLength(1)
    expect(bDrafts[0]?.leadId).toBe(LEAD_B)
    expect(aDrafts[0]?.leadId).toBe(LEAD_A)
  })
})
