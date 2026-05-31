/**
 * Resend (email delivery) integration types (Sprint 9 CP4).
 *
 * Wraps the Resend HTTP API for the Outreach Operator's email channel.
 * Mock-default (RESEND_LIVE !== 'true'); the live POST is wired but only the
 * deliberate Sprint 9.5 first-send (Felipe → himself) exercises it.
 */

export interface ResendSendInput {
  /** Verified sender (orgs.sender_email in live; placeholder in mock). */
  from: string
  to: string
  subject: string
  /** Resend requires a text part; html is optional. */
  text: string
  html?: string
}

export interface ResendSendResult {
  /** Resend returns { id } on a 200 send. */
  id: string
}

export interface ResendTestConnectionResult {
  ok: boolean
  error?: 'INVALID_KEY' | 'CONNECTION_FAILED'
}
