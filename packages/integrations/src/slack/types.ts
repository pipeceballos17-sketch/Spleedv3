/**
 * Slack Incoming Webhook types (Sprint 5b CP3). Sprint 5b ships text-only
 * messages — Block Kit + interactive buttons land with the full OAuth flow
 * in Sprint 9 (BACKLOG-035).
 */

export interface SlackSendResult {
  /** Whether the webhook POST returned 200. False on mock + on real failure. */
  success: boolean
  /** Mock mode: the rendered payload, so tests can assert message shape. */
  mockedPayload?: { text: string }
}

export interface ScoutFailurePayload {
  runId: string
  icpName: string
  error: { category: string; message: string; code?: string }
}

export interface QuotaExhaustedPayload {
  provider: 'apollo' | 'anthropic'
  /** -1 sentinel when the provider doesn't expose remaining credits in the error. */
  creditsRemaining: number
  /** Optional context to help the founder act (e.g. "upgrade to Pro tier"). */
  upgradeHint?: string
}
