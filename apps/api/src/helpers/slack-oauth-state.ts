/**
 * Slack OAuth `state` signing (Sprint 7c — CSRF protection).
 *
 * The OAuth install flow sends the founder to Slack with a `state` param we
 * generate; Slack echoes it back to /api/slack/oauth/callback. We HMAC-sign
 * it with a Spleed-only secret so a forged callback (attacker tricks a
 * founder into completing an install that binds the attacker's workspace to
 * the founder's org, or vice-versa) is rejected: a tampered orgId fails the
 * signature check.
 *
 * Format: `<orgId>.<issuedAtMs>.<nonce>.<sig>` where
 *   sig = HMAC-SHA256(secret, "<orgId>.<issuedAtMs>.<nonce>")
 *
 * issuedAtMs lets us expire stale states (install link clicked days later).
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

/** States older than this are rejected — install link is single-session. */
const STATE_TTL_MS = 10 * 60 * 1000

/**
 * Dedicated state secret, falling back to the Slack signing secret for dev
 * (.env.local ships SLACK_SIGNING_SECRET; SLACK_STATE_SECRET is optional).
 * Sprint 8+ should set a distinct SLACK_STATE_SECRET in prod.
 */
function stateSecret(): string {
  const secret = process.env.SLACK_STATE_SECRET ?? process.env.SLACK_SIGNING_SECRET
  if (!secret) {
    throw new Error(
      'SLACK_STATE_SECRET (or SLACK_SIGNING_SECRET) must be set to sign Slack OAuth state',
    )
  }
  return secret
}

function sign(body: string): string {
  return createHmac('sha256', stateSecret()).update(body).digest('hex')
}

/** Build a signed state param binding this OAuth flow to `orgId`. */
export function signOAuthState(orgId: string, nowMs: number = Date.now()): string {
  const body = `${orgId}.${nowMs}.${randomUUID()}`
  return `${body}.${sign(body)}`
}

/**
 * Verify a state param. Returns the embedded orgId on success, or null on
 * any failure (malformed, bad signature, expired). Constant-time signature
 * compare guards against timing attacks.
 */
export function verifyOAuthState(
  state: string | null | undefined,
  nowMs: number = Date.now(),
): { orgId: string } | null {
  if (!state) return null
  const parts = state.split('.')
  if (parts.length !== 4) return null
  const [orgId, issuedAtRaw, nonce, sig] = parts as [string, string, string, string]

  const body = `${orgId}.${issuedAtRaw}.${nonce}`
  const expected = sign(body)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const issuedAt = Number(issuedAtRaw)
  if (!Number.isFinite(issuedAt) || nowMs - issuedAt > STATE_TTL_MS) return null

  return { orgId }
}
