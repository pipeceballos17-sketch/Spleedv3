/**
 * Sprint 7c — POST /api/slack/events integration tests (3 tests).
 *
 * Drives the API dispatch handler via synthetic Request objects (no port
 * binding). Covers the Slack URL-verification handshake, the message.im →
 * concierge-enqueue happy path, and signature-verification security
 * (valid/invalid/missing/stale).
 *
 * The enqueue assertion needs REDIS_URL (BullMQ concierge queue).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { closeServiceClient, getServiceClient, orgs, users } from '@spleed/db'
import { closeRedisConnection, createQueue } from '@spleed/agents/workers'
import { dispatch } from '../index'

const SLACK_ORG = '77777777-0000-0000-0000-0000000000ee'
const SLACK_USER = '77777777-0000-0000-0000-0000000000e1'
const SLACK_USER_AUTH = '77777777-0000-0000-0000-0000000000e2'
const SLACK_TEAM_ID = 'T_EVENTS_TEST'
const SIGNING_SECRET = 'events-test-signing-secret'
const CONCIERGE_QUEUE = 'concierge'

function signedEventRequest(
  body: unknown,
  opts: { ts?: string; signature?: string } = {},
): Request {
  const raw = JSON.stringify(body)
  const ts = opts.ts ?? Math.floor(Date.now() / 1000).toString()
  const signature =
    opts.signature ??
    'v0=' + createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest('hex')
  return new Request('http://localhost:3001/api/slack/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': signature,
    },
    body: raw,
  })
}

async function clearConciergeQueue(): Promise<void> {
  const queue = createQueue(CONCIERGE_QUEUE)
  try {
    await queue.obliterate({ force: true })
  } catch {
    // Queue may not exist yet — non-fatal.
  } finally {
    await queue.close()
  }
}

beforeAll(async () => {
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await db.insert(orgs).values({
    id: SLACK_ORG,
    name: 'Slack Events Org',
    slug: 'slack-events',
    slackTeamId: SLACK_TEAM_ID,
    slackBotUserId: 'U_BOT_EVENTS',
  })
  await db.insert(users).values({
    id: SLACK_USER,
    supabaseAuthId: SLACK_USER_AUTH,
    email: 'events@slack.test',
    name: 'Events',
  })
})

afterAll(async () => {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await clearConciergeQueue()
  await closeRedisConnection()
  await closeServiceClient()
})

beforeEach(async () => {
  await clearConciergeQueue()
})

describe('POST /api/slack/events — URL verification', () => {
  it('echoes the challenge on a signed url_verification', async () => {
    const res = await dispatch(
      signedEventRequest({ type: 'url_verification', challenge: 'chal_abc123' }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { challenge: string }
    expect(body.challenge).toBe('chal_abc123')
  })
})

describe('POST /api/slack/events — message.im enqueue', () => {
  it('maps team_id → org and enqueues a concierge job (unknown team = graceful no-op)', async () => {
    const ts = '1700000099.000200'
    const res = await dispatch(
      signedEventRequest({
        type: 'event_callback',
        team_id: SLACK_TEAM_ID,
        event: {
          type: 'message',
          channel_type: 'im',
          channel: 'D_FOUNDER',
          user: 'U_FOUNDER',
          text: 'who is Sarah Chen from PulseAnalytics',
          ts,
        },
      }),
    )
    // Slack must get a fast 200 — processing is async.
    expect(res.status).toBe(200)

    // Idempotency key is `concierge-{orgId}-{ts}` — assert the job landed.
    const queue = createQueue(CONCIERGE_QUEUE)
    const job = await queue.getJob(`concierge-${SLACK_ORG}-${ts}`)
    expect(job).toBeDefined()
    expect(job?.data).toMatchObject({
      orgId: SLACK_ORG,
      slackChannelId: 'D_FOUNDER',
      slackUserId: 'U_FOUNDER',
      slackThreadTs: ts,
      text: 'who is Sarah Chen from PulseAnalytics',
    })

    // Unknown workspace → graceful 200, no enqueue (never leak existence).
    const unknownTs = '1700000099.000300'
    const resUnknown = await dispatch(
      signedEventRequest({
        type: 'event_callback',
        team_id: 'T_UNKNOWN_WORKSPACE',
        event: {
          type: 'message',
          channel_type: 'im',
          channel: 'D_X',
          user: 'U_X',
          text: 'who is X from Y',
          ts: unknownTs,
        },
      }),
    )
    expect(resUnknown.status).toBe(200)
    const unknownJob = await queue.getJob(`concierge-T_UNKNOWN_WORKSPACE-${unknownTs}`)
    expect(unknownJob).toBeUndefined()
    await queue.close()
  })
})

describe('POST /api/slack/events — signature verification', () => {
  it('accepts valid, rejects invalid / missing / stale (replay window) with 401', async () => {
    const body = { type: 'url_verification', challenge: 'sec_check' }

    // Valid → 200.
    expect((await dispatch(signedEventRequest(body))).status).toBe(200)

    // Tampered signature → 401.
    expect((await dispatch(signedEventRequest(body, { signature: 'v0=deadbeef' }))).status).toBe(401)

    // Missing signature header → 401.
    const noSig = new Request('http://localhost:3001/api/slack/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect((await dispatch(noSig)).status).toBe(401)

    // Stale timestamp (signed correctly, but >5min old) → 401 via replay window.
    const staleTs = (Math.floor(Date.now() / 1000) - 600).toString()
    expect((await dispatch(signedEventRequest(body, { ts: staleTs }))).status).toBe(401)
  })
})
