/**
 * Concierge agent types (Sprint 7c — Slack DM → ingest payload NLP).
 *
 * The concierge parser turns a free-text founder DM ("who is Sarah Chen
 * from PulseAnalytics") into the structured body POST /api/leads/ingest
 * expects. The Anthropic client returns a nullable ConciergePayload; this
 * layer normalizes it into IngestPayload (optional fields, nulls dropped)
 * so the concierge worker (CP3) can forward it to the API verbatim.
 */

import type { AnthropicClient } from '@spleed/integrations/anthropic'

/**
 * Parser input. Pairs the raw founder text with a (mock-aware) Anthropic
 * client. Sprint 8+ swaps in a real-mode client configured with the
 * Spleed-managed Haiku key (concierge stays Spleed-billed until BACKLOG-027
 * BYOK lands — see AnthropicClient.parseConciergeQuery).
 */
export interface ConciergeQuery {
  /** Raw founder text from the Slack DM. */
  text: string
  anthropicClient: AnthropicClient
}

/**
 * Structured ingest payload — a subset of POST /api/leads/ingest body.
 * `icpId` is intentionally absent: parsing never assigns it (the ingest
 * endpoint resolves the org's default ICP). Mirrors apps/api
 * IngestPayloadSchema structurally so the concierge worker (CP3) can POST
 * this object without translation. Fields are optional because Haiku may
 * surface only some of them depending on what the founder typed.
 */
export interface IngestPayload {
  linkedinUrl?: string
  companyDomain?: string
  name?: string
  title?: string
  notes?: string
}

/** Alias documenting the parser's normalized structured output. */
export type ParsedConciergeQuery = IngestPayload

/**
 * Parser result. `payload` is always present (empty object on a failed
 * parse); `parseSucceeded` gates whether the worker should proceed to
 * ingest or reply to the founder asking for clarification. Cost/latency
 * metadata flows to cost_events (Sprint 5a infra) for per-tenant spend
 * visibility.
 */
export interface ParseConciergeResult {
  payload: IngestPayload
  parseSucceeded: boolean
  /** Set only when parseSucceeded=false — surfaced to the founder verbatim. */
  errorReason?: string
  costUsd: number
  tokensIn: number
  tokensOut: number
  latencyMs: number
}
