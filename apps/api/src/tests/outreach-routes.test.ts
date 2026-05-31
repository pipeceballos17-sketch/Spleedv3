/**
 * Sprint 8.2 + Sprint 9 CP4 — outreach + BYOK route tests (6 tests).
 *
 * Reply webhook ingest + STOP auto-unsubscribe, Anthropic guided BYOK, and
 * Resend guided BYOK (Sprint 9 CP4) happy/invalid paths. Drives dispatch with
 * synthetic Requests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import {
  closeServiceClient,
  getServiceClient,
  leads as leadsTable,
  orgs,
  outreachReplies as outreachRepliesTable,
  outreachUnsubscribes as outreachUnsubscribesTable,
  users,
} from '@spleed/db'
import { getAnthropicApiKey, resetMockAnthropicTokenStore } from '@spleed/integrations/anthropic'
import { getResendApiKey, resetMockResendTokenStore } from '@spleed/integrations/resend'
import { dispatch } from '../index'
import { signReplyWebhook } from '../helpers/reply-webhook-signature'

const ORG = 'e0000000-0000-4000-8000-0000000000f1'
const USER = 'e0000000-0000-4000-8000-0000000000f2'
const USER_AUTH = 'e0000000-0000-4000-8000-0000000000f3'
const LEAD = 'e0000000-0000-4000-8000-0000000000f4'
const LEAD_EMAIL = 'lead@replytest.com'

function replyRequest(body: string): Request {
  const payload = JSON.stringify({ lead_id: LEAD, body, received_at: new Date().toISOString(), source: 'mock' })
  const { signature, timestamp } = signReplyWebhook({ rawBody: payload })
  return new Request('http://localhost:3001/api/outreach/reply-webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-spleed-reply-signature': signature,
      'x-spleed-reply-timestamp': timestamp,
    },
    body: payload,
  })
}

function verifyKeyRequest(apiKey: string): Request {
  return new Request('http://localhost:3001/api/anthropic/verify-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: ORG, apiKey }),
  })
}

function verifyResendKeyRequest(apiKey: string, senderEmail?: string): Request {
  return new Request('http://localhost:3001/api/resend/verify-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: ORG, apiKey, ...(senderEmail ? { senderEmail } : {}) }),
  })
}

beforeAll(async () => {
  process.env.SLACK_SIGNING_SECRET = 'outreach-routes-signing'
  process.env.REPLY_WEBHOOK_SECRET = 'outreach-routes-reply'
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await db.insert(orgs).values({ id: ORG, name: 'Outreach Routes Org', slug: 'outreach-routes' })
  await db.insert(users).values({ id: USER, supabaseAuthId: USER_AUTH, email: 'r@routes.test', name: 'R' })
  await db.insert(leadsTable).values({
    id: LEAD, orgId: ORG, status: 'enriched', fullName: 'Reply Lead', company: 'Co',
    email: LEAD_EMAIL, foundVia: 'test',
  })
})

afterAll(async () => {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await closeServiceClient()
})

beforeEach(async () => {
  resetMockAnthropicTokenStore()
  resetMockResendTokenStore()
  const db = getServiceClient()
  await db.delete(outreachRepliesTable).where(eq(outreachRepliesTable.orgId, ORG))
  await db.delete(outreachUnsubscribesTable).where(eq(outreachUnsubscribesTable.orgId, ORG))
  await db
    .update(orgs)
    .set({
      anthropicVaultRef: null,
      anthropicConnectedAt: null,
      resendVaultRef: null,
      resendConnectedAt: null,
      senderEmail: null,
    })
    .where(eq(orgs.id, ORG))
})

describe('POST /api/outreach/reply-webhook', () => {
  it('ingests a reply → outreach_replies row created', async () => {
    const res = await dispatch(replyRequest("This is interesting, let's chat"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { replyId: string; parsedIntent: string | null }
    expect(body.parsedIntent).toBe('engaged')

    const db = getServiceClient()
    const rows = await db.select().from(outreachRepliesTable).where(eq(outreachRepliesTable.orgId, ORG))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.leadId).toBe(LEAD)
    expect(rows[0]?.parsedIntent).toBe('engaged')
  })

  it('STOP reply → auto-inserts outreach_unsubscribes (source=reply_stop)', async () => {
    const res = await dispatch(replyRequest('STOP'))
    expect(res.status).toBe(200)
    const db = getServiceClient()
    const [unsub] = await db
      .select()
      .from(outreachUnsubscribesTable)
      .where(and(eq(outreachUnsubscribesTable.orgId, ORG), eq(outreachUnsubscribesTable.identifier, LEAD_EMAIL)))
    expect(unsub).toBeDefined()
    expect(unsub?.source).toBe('reply_stop')
    expect(unsub?.channel).toBe('email')
  })
})

describe('Anthropic guided BYOK', () => {
  it('happy path: sk-ant-test key → 200 + Vault store + orgs stamped', async () => {
    const res = await dispatch(verifyKeyRequest('sk-ant-test-routes123'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; plan_detected: string | null }
    expect(body.success).toBe(true)
    expect(body.plan_detected).toBe('Pro')

    expect(await getAnthropicApiKey(ORG)).toBe('sk-ant-test-routes123')
    const db = getServiceClient()
    const [org] = await db.select().from(orgs).where(eq(orgs.id, ORG))
    expect(org?.anthropicVaultRef).toBe(`anthropic_api_key_${ORG}`)
    expect(org?.anthropicConnectedAt).toBeInstanceOf(Date)
  })

  it('invalid key format → 400 INVALID_KEY, nothing stored', async () => {
    const res = await dispatch(verifyKeyRequest('not-a-real-key'))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('INVALID_KEY')
    expect(await getAnthropicApiKey(ORG)).toBeNull()
  })
})

describe('Resend guided BYOK (Sprint 9 CP4)', () => {
  it('happy path: re_ key + sender → 200 + Vault store + orgs stamped (ref/connectedAt/sender)', async () => {
    const res = await dispatch(verifyResendKeyRequest('re_routes_test_123', 'founder@acme.com'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; message: string }
    expect(body.success).toBe(true)

    expect(await getResendApiKey(ORG)).toBe('re_routes_test_123')
    const db = getServiceClient()
    const [org] = await db.select().from(orgs).where(eq(orgs.id, ORG))
    expect(org?.resendVaultRef).toBe(`resend_api_key_${ORG}`)
    expect(org?.resendConnectedAt).toBeInstanceOf(Date)
    expect(org?.senderEmail).toBe('founder@acme.com')
  })

  it('invalid key format (not re_) → 400 INVALID_KEY, nothing stored', async () => {
    const res = await dispatch(verifyResendKeyRequest('sk-wrong-prefix'))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('INVALID_KEY')
    expect(await getResendApiKey(ORG)).toBeNull()
    const db = getServiceClient()
    const [org] = await db.select().from(orgs).where(eq(orgs.id, ORG))
    expect(org?.resendVaultRef).toBeNull()
  })
})
