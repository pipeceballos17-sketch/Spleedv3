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
}
