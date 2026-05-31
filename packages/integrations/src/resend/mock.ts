import type { ResendSendInput, ResendSendResult } from './types'

/**
 * Deterministic mock send — no network. Same (to, subject) → same id, so
 * cost_events / tests are stable. Mirrors the synthetic-id pattern the
 * Outreach Operator used before Resend was wired.
 */
export function mockResendSend(input: ResendSendInput): ResendSendResult {
  const seed = `${input.to}:${input.subject}`
  const hash = [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7)
  return { id: `mock-resend-${hash.toString(16)}` }
}
