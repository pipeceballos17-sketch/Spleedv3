/**
 * Slack request signature verification (Sprint 7c).
 *
 * Slack signs every webhook delivery with HMAC-SHA256 over
 * `v0:{timestamp}:{raw_body}` using the app's signing secret. The bot
 * MUST verify this before processing any event — without it a bad actor
 * could replay arbitrary message.im payloads at our public endpoint.
 *
 * Spec: https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Implementation notes:
 *   - Uses Bun/Node `crypto` (subtle API would also work; this is fine
 *     for the server-only context the worker runs in).
 *   - Constant-time comparison via `crypto.timingSafeEqual` to thwart
 *     timing attacks.
 *   - Rejects timestamps older than 5 minutes (replay protection per Slack docs).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface VerifySlackSignatureInput {
  signingSecret: string
  /** Value of `x-slack-request-timestamp` header. */
  timestamp: string | null | undefined
  /** Value of `x-slack-signature` header (prefixed `v0=`). */
  signature: string | null | undefined
  /** Raw request body — caller must pass the unparsed string. */
  rawBody: string
  /** Override the wall clock for testing. */
  nowMs?: number
}

/** Reject payloads older than this — Slack's documented threshold. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000

export function verifySlackSignature(input: VerifySlackSignatureInput): boolean {
  const { signingSecret, timestamp, signature, rawBody } = input
  if (!timestamp || !signature) return false

  const tsNum = Number(timestamp)
  if (!Number.isFinite(tsNum) || tsNum <= 0) return false

  // Replay-window check. Slack ts is seconds-since-epoch.
  const now = input.nowMs ?? Date.now()
  if (Math.abs(now / 1000 - tsNum) * 1000 > REPLAY_WINDOW_MS) return false

  // Compute expected signature.
  const baseString = `v0:${timestamp}:${rawBody}`
  const computed = 'v0=' + createHmac('sha256', signingSecret).update(baseString).digest('hex')

  // Constant-time compare. Length mismatch ⇒ instantly false (timingSafeEqual
  // throws on differing lengths).
  const aBuf = Buffer.from(computed)
  const bBuf = Buffer.from(signature)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}
