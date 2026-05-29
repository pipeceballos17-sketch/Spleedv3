/**
 * Sprint 7c — GET /api/slack/oauth/callback integration tests (2 tests).
 *
 * Covers the install-completion success path (code → tokens → Vault +
 * orgs stamp + HTML confirmation) and the CSRF guard (tampered state → 400,
 * no side effects). SlackClient is mock-default so exchangeOAuthCode returns
 * deterministic fake tokens without touching real Slack.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { sql, eq } from 'drizzle-orm'
import { closeServiceClient, getServiceClient, orgs } from '@spleed/db'
import {
  getSlackOAuthTokens,
  mockExchangeOAuthCode,
  resetMockSlackTokenStore,
} from '@spleed/integrations/slack'
import { dispatch } from '../index'
import { signOAuthState } from '../helpers/slack-oauth-state'

const OAUTH_ORG = '88888888-0000-0000-0000-0000000000ee'

function callbackRequest(code: string, state: string): Request {
  const u = new URL('http://localhost:3001/api/slack/oauth/callback')
  u.searchParams.set('code', code)
  u.searchParams.set('state', state)
  return new Request(u.toString(), { method: 'GET' })
}

beforeAll(async () => {
  process.env.SLACK_STATE_SECRET = 'oauth-callback-test-secret'
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await db.insert(orgs).values({ id: OAUTH_ORG, name: 'OAuth Org', slug: 'oauth-org' })
})

afterAll(async () => {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await closeServiceClient()
})

beforeEach(async () => {
  resetMockSlackTokenStore()
  // Reset the org's slack columns between cases.
  const db = getServiceClient()
  await db
    .update(orgs)
    .set({ slackTeamId: null, slackBotUserId: null, slackConnectedAt: null })
    .where(eq(orgs.id, OAUTH_ORG))
})

describe('GET /api/slack/oauth/callback — success', () => {
  it('exchanges code → stores tokens + stamps orgs + returns HTML', async () => {
    const code = 'democode'
    const expected = mockExchangeOAuthCode(code)
    const state = signOAuthState(OAUTH_ORG)

    const res = await dispatch(callbackRequest(code, state))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    // Tokens persisted to (mock) Vault.
    const tokens = await getSlackOAuthTokens(OAUTH_ORG)
    expect(tokens?.bot_token).toBe(expected.bot_token)
    expect(tokens?.team_id).toBe(expected.team_id)

    // orgs lookup columns stamped so Slack events can map team_id → org.
    const db = getServiceClient()
    const [org] = await db.select().from(orgs).where(eq(orgs.id, OAUTH_ORG))
    expect(org?.slackTeamId).toBe(expected.team_id)
    expect(org?.slackBotUserId).toBe(expected.bot_user_id)
    expect(org?.slackConnectedAt).toBeInstanceOf(Date)
  })
})

describe('GET /api/slack/oauth/callback — tampered state', () => {
  it('rejects a tampered state with 400 INVALID_STATE and no side effects', async () => {
    const state = signOAuthState(OAUTH_ORG)
    // Swap the embedded orgId for a different UUID — breaks the HMAC.
    const tampered = state.replace(OAUTH_ORG, '88888888-0000-0000-0000-0000000000ff')

    const res = await dispatch(callbackRequest('democode', tampered))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('INVALID_STATE')

    // No tokens stored, no orgs mutation.
    expect(await getSlackOAuthTokens(OAUTH_ORG)).toBeNull()
    const db = getServiceClient()
    const [org] = await db.select().from(orgs).where(eq(orgs.id, OAUTH_ORG))
    expect(org?.slackTeamId).toBeNull()
    expect(org?.slackConnectedAt).toBeNull()
  })
})
