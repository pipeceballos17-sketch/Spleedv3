/**
 * Inbound reply webhook signature (Sprint 8.2).
 *
 * Reuses the Slack request-signing scheme (HMAC-SHA256 over
 * `v0:{timestamp}:{rawBody}`, constant-time compare, replay window) for the
 * POST /api/outreach/reply-webhook endpoint. Sendblue/IMAP relays (Sprint 9+)
 * sign their deliveries with REPLY_WEBHOOK_SECRET; mock/manual relays sign
 * with the same secret so the verification path is identical in tests.
 *
 * Secret resolution: REPLY_WEBHOOK_SECRET, falling back to SLACK_SIGNING_SECRET
 * for dev (mirrors the SLACK_STATE_SECRET fallback in slack-oauth-state.ts).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Reject payloads older than this (replay protection). */
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000

function replySecret(override?: string): string {
  const secret = override ?? process.env.REPLY_WEBHOOK_SECRET ?? process.env.SLACK_SIGNING_SECRET
  if (!secret) {
    throw new Error(
      'REPLY_WEBHOOK_SECRET (or SLACK_SIGNING_SECRET) must be set to verify reply webhooks',
    )
  }
  return secret
}

function compute(secret: string, timestamp: string, rawBody: string): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')
}

export interface SignReplyWebhookInput {
  rawBody: string
  /** Seconds-since-epoch. Defaults to now. */
  timestampSec?: number
  secret?: string
}

/** Produce the headers a relay would send. Used by tests + the demo. */
export function signReplyWebhook(input: SignReplyWebhookInput): {
  signature: string
  timestamp: string
} {
  const timestamp = String(input.timestampSec ?? Math.floor(Date.now() / 1000))
  return { signature: compute(replySecret(input.secret), timestamp, input.rawBody), timestamp }
}

export interface VerifyReplyWebhookInput {
  rawBody: string
  signature: string | null | undefined
  timestamp: string | null | undefined
  secret?: string
  maxAgeMs?: number
  nowMs?: number
}

export function verifyReplyWebhook(input: VerifyReplyWebhookInput): boolean {
  const { rawBody, signature, timestamp } = input
  if (!signature || !timestamp) return false

  const tsNum = Number(timestamp)
  if (!Number.isFinite(tsNum) || tsNum <= 0) return false

  const now = input.nowMs ?? Date.now()
  const maxAge = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  if (Math.abs(now / 1000 - tsNum) * 1000 > maxAge) return false

  const expected = compute(replySecret(input.secret), timestamp, rawBody)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
