/**
 * Concierge parser (Sprint 7c) — free-text founder DM → ingest payload.
 *
 * Calls AnthropicClient.parseConciergeQuery (Haiku-pinned, mock-default),
 * then normalizes the nullable ConciergePayload it returns into the
 * IngestPayload shape POST /api/leads/ingest expects (nulls dropped → fields
 * omitted). The endpoint does its own URL/domain normalization, so this
 * layer passes the values straight through without re-normalizing.
 */

import type { ConciergePayload } from '@spleed/integrations/anthropic'
import { CONCIERGE_PARSER_PROMPT, buildConciergeParserUserPrompt } from './prompts'
import type { ConciergeQuery, IngestPayload, ParseConciergeResult } from './types'

/**
 * Drop null fields so the payload matches IngestPayloadSchema's optional
 * shape (Zod `.optional()` rejects explicit nulls — undefined/omitted is the
 * contract). icpId is never carried: the ingest endpoint assigns it.
 */
function toIngestPayload(p: ConciergePayload): IngestPayload {
  const out: IngestPayload = {}
  if (p.linkedinUrl) out.linkedinUrl = p.linkedinUrl
  if (p.companyDomain) out.companyDomain = p.companyDomain
  if (p.name) out.name = p.name
  if (p.title) out.title = p.title
  if (p.notes) out.notes = p.notes
  return out
}

export async function parseConciergeQuery(
  input: ConciergeQuery,
): Promise<ParseConciergeResult> {
  const userPrompt = buildConciergeParserUserPrompt(input.text)

  // Mock returns curated payloads by pattern-matching textHint. Live (Sprint
  // 8+) calls @anthropic-ai/sdk Messages.create on Haiku 4.5 with the system
  // prompt marked cache_control=ephemeral.
  const result = await input.anthropicClient.parseConciergeQuery({
    systemPrompt: CONCIERGE_PARSER_PROMPT,
    userPrompt,
    textHint: input.text,
  })

  return {
    payload: toIngestPayload(result.payload),
    parseSucceeded: result.parseSucceeded,
    errorReason: result.errorReason ?? undefined,
    costUsd: result.costUsd,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    latencyMs: result.latencyMs,
  }
}
