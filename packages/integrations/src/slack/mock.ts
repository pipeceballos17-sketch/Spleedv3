/**
 * In-memory capture of mock Slack sends. Tests import `MOCK_SLACK_SENDS`
 * to assert payload shape without reaching the network.
 *
 * The array survives across test invocations within the same Bun process —
 * tests that care about isolation should call `resetMockSlackSends()` in
 * `beforeEach`.
 */
export interface MockSlackSend {
  webhookUrl: string
  text: string
  sentAt: Date
}

export const MOCK_SLACK_SENDS: MockSlackSend[] = []

export function resetMockSlackSends(): void {
  MOCK_SLACK_SENDS.length = 0
}

// ─── Sprint 7c — SlackClient (OAuth bot) mock state ────────────────

import type {
  SlackBlock,
  SlackOAuthExchangeResult,
  SlackPostMessageResult,
  SlackUserInfo,
} from './types'

export interface MockSlackPostMessage {
  channel: string
  text?: string
  blocks?: SlackBlock[]
  thread_ts?: string
  postedAt: Date
  /** Deterministic ts the mock returns; tests use it to assert thread replies. */
  ts: string
}

/** In-memory capture of mock postMessage calls. */
export const MOCK_SLACK_POST_MESSAGES: MockSlackPostMessage[] = []

export function resetMockSlackPostMessages(): void {
  MOCK_SLACK_POST_MESSAGES.length = 0
}

/**
 * Deterministic Slack timestamp generator. Slack ts is `seconds.microseconds`;
 * counter-based so tests assert exact equality without clock dependency.
 */
let mockTsCounter = 1_700_000_000
function nextMockTs(): string {
  mockTsCounter += 1
  return `${mockTsCounter}.000100`
}

export function mockPostMessage(input: {
  channel: string
  text?: string
  blocks?: SlackBlock[]
  thread_ts?: string
}): SlackPostMessageResult {
  const ts = nextMockTs()
  MOCK_SLACK_POST_MESSAGES.push({
    channel: input.channel,
    text: input.text,
    blocks: input.blocks,
    thread_ts: input.thread_ts,
    postedAt: new Date(),
    ts,
  })
  return { ok: true, ts, channel: input.channel }
}

/**
 * Mock OAuth code → token exchange. The same code always resolves to the
 * same fake tokens so OAuth-callback tests are deterministic. Bot/user
 * tokens carry the conventional Slack prefixes (xoxb-*, xoxp-*) so any
 * downstream regex that checks token shape still passes.
 */
export function mockExchangeOAuthCode(code: string): SlackOAuthExchangeResult {
  // Deterministic per-code: short hash → suffix
  const charSum = [...code].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  const suffix = charSum.toString(16).padStart(8, '0')
  return {
    access_token: `xoxp-mock-${suffix}`,
    bot_token: `xoxb-mock-${suffix}`,
    team_id: `T_MOCK_${suffix.toUpperCase()}`,
    bot_user_id: `U_BOT_${suffix.toUpperCase()}`,
    team_name: 'Mock Slack Workspace',
  }
}

/**
 * Mock users.info — returns a synthesized profile keyed off the userId
 * so tests can assert founder vs bot detection without a real Slack roundtrip.
 */
export function mockGetUserInfo(userId: string): SlackUserInfo {
  const isBot = userId.startsWith('U_BOT_')
  return {
    user_id: userId,
    name: isBot ? 'spleed_bot' : `user_${userId.slice(-4).toLowerCase()}`,
    real_name: isBot ? 'Spleed Concierge' : undefined,
    is_bot: isBot,
  }
}
