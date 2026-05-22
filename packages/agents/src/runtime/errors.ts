/**
 * Tagged errors used by the agent runtime and tools layer.
 *
 * `transient` errors signal that the operation can be retried by BullMQ
 * (Apollo rate limit, Apify session expired, network blip). `permanent`
 * errors go straight to the dead-letter queue (auth failed, lead not found,
 * malformed input). The worker `define.ts` reads `error.transient` to decide.
 */

export type ErrorClassification = 'transient' | 'permanent'

export interface TaggedAgentErrorOptions {
  classification?: ErrorClassification
  context?: Record<string, unknown>
  cause?: unknown
}

export class TaggedAgentError extends Error {
  readonly tag: string
  readonly classification: ErrorClassification
  readonly context: Record<string, unknown>

  constructor(tag: string, message: string, options: TaggedAgentErrorOptions = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'TaggedAgentError'
    this.tag = tag
    this.classification = options.classification ?? 'permanent'
    this.context = options.context ?? {}
  }

  get transient(): boolean {
    return this.classification === 'transient'
  }
}

/**
 * Common error factories. Agents/tools call these instead of constructing
 * directly so the tag strings stay consistent across the codebase.
 */
export const errors = {
  rateLimit: (provider: string, retryAfterSeconds?: number) =>
    new TaggedAgentError(
      `${provider.toUpperCase()}_RATE_LIMIT`,
      `${provider} rate limit hit`,
      { classification: 'transient', context: { retryAfterSeconds } },
    ),
  authFailed: (provider: string) =>
    new TaggedAgentError(
      `${provider.toUpperCase()}_AUTH_FAILED`,
      `${provider} authentication failed — credential may have been rotated or revoked`,
      { classification: 'permanent' },
    ),
  notConnected: (provider: string) =>
    new TaggedAgentError(
      `${provider.toUpperCase()}_NOT_CONNECTED`,
      `${provider} integration not connected for this org. Founder needs to connect first.`,
      { classification: 'permanent' },
    ),
  networkTimeout: (provider: string, timeoutMs: number) =>
    new TaggedAgentError(
      `${provider.toUpperCase()}_NETWORK_TIMEOUT`,
      `${provider} request timed out after ${timeoutMs}ms`,
      { classification: 'transient', context: { timeoutMs } },
    ),
  // Sprint 5b CP3 — quota exhaustion. Distinct from rateLimit (which is
  // recoverable by waiting); QUOTA means founder needs to upgrade their
  // plan. Slack notification fires on this category (Decision E).
  quotaExhausted: (provider: string, context?: Record<string, unknown>) =>
    new TaggedAgentError(
      `${provider.toUpperCase()}_QUOTA_EXHAUSTED`,
      `${provider} quota exhausted — upgrade plan to resume`,
      { classification: 'permanent', context },
    ),
}

// ─── Sprint 5b CP3 — Granular error categorisation ───────────────────

/**
 * Scout-level error category. Sprint 5b extends the runtime's binary
 * transient/permanent split into 4 buckets so the worker can route:
 *   - TRANSIENT: retry intra-job with exponential backoff (1-2-4s)
 *   - PERMANENT: stop immediately + notify Slack (auth bad, key revoked)
 *   - PARTIAL:   some items succeeded — log failures, mark run 'partial'
 *   - QUOTA:     credit/tier limit hit — stop + notify Slack with upgrade hint
 *
 * Maps onto TaggedAgentError.classification at the BullMQ boundary
 * (TRANSIENT → transient; PERMANENT/QUOTA → permanent → DLQ; PARTIAL never
 * surfaces as an error — it's a status assertion the worker makes itself).
 */
export type ErrorCategory = 'transient' | 'permanent' | 'partial' | 'quota'

/**
 * Inspect a thrown error and classify it. Provider-specific heuristics for
 * Apollo and Anthropic; everything unknown defaults to TRANSIENT to err on
 * the side of retrying rather than failing loudly (Sprint 5b is the first
 * deployment of this — being lenient gives us a chance to observe real
 * failures and tighten classification in Sprint 6+).
 *
 * Inputs accept `unknown` so callers don't have to narrow before classifying.
 */
export function classifyError(error: unknown, provider: string): ErrorCategory {
  // Honor explicit signals first: TaggedAgentError already carries category.
  if (error instanceof TaggedAgentError) {
    if (error.tag.endsWith('_QUOTA_EXHAUSTED')) return 'quota'
    if (error.tag.endsWith('_AUTH_FAILED')) return 'permanent'
    if (error.tag.endsWith('_NOT_CONNECTED')) return 'permanent'
    if (error.classification === 'transient') return 'transient'
    return 'permanent'
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()

  // Quota signals — provider-specific keywords. Sprint 5b checks both Apollo
  // and Anthropic; future providers extend this match list.
  if (
    message.includes('quota') ||
    message.includes('credits exhausted') ||
    message.includes('credits=0') ||
    message.includes('tier limit') ||
    message.includes('plan limit') ||
    message.includes('upgrade required')
  ) {
    return 'quota'
  }

  // Permanent — auth failures, malformed config. Includes both Apollo
  // (401/403 messages) and Anthropic (invalid_api_key).
  if (
    message.includes('401') ||
    message.includes('403') ||
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('auth failed') ||
    message.includes('invalid api key') ||
    message.includes('invalid_api_key') ||
    message.includes('not connected')
  ) {
    return 'permanent'
  }

  // Transient — rate limits, server errors, network blips. Default for any
  // 5xx / timeout / connection failure.
  if (
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    /\b5\d\d\b/.test(message) // 500-599 status
  ) {
    return 'transient'
  }

  // Suppress unused-param lint: the provider arg lets us tighten heuristics
  // per-provider later (e.g. Apollo-specific error codes). For now it
  // disambiguates only in logging at call sites.
  void provider
  return 'transient'
}

/**
 * Retry a transient operation with intra-job exponential backoff. Default
 * cadence 1s/2s/4s. After `maxRetries`, the last error is re-thrown so
 * the worker's outer catch can mark the run as PERMANENT and notify Slack.
 *
 * Tests pass `{ backoffBaseMs: 1 }` to keep total runtime under 10ms.
 *
 * NB: this is *intra-job* retry, distinct from BullMQ's job-level retry
 * (configured in defineWorker.retry). Scout worker tightens BullMQ to 1
 * attempt so the two layers don't compound to 15 total attempts.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  provider: string,
  options: { maxRetries?: number; backoffBaseMs?: number } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3
  const backoffBaseMs = options.backoffBaseMs ?? 1000
  let lastError: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const category = classifyError(err, provider)
      // PERMANENT and QUOTA escalate immediately — no point waiting.
      // PARTIAL never reaches here (it's not an exception).
      if (category !== 'transient' || attempt === maxRetries - 1) {
        throw err
      }
      const backoff = backoffBaseMs * Math.pow(2, attempt)
      await new Promise((r) => setTimeout(r, backoff))
    }
  }
  throw lastError
}
