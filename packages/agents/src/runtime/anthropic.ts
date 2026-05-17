import Anthropic from '@anthropic-ai/sdk'
import { TaggedAgentError } from './errors'

let _client: Anthropic | null = null

/**
 * Singleton Anthropic client. Reads ANTHROPIC_API_KEY from env on first call.
 * Errors loudly if env is missing — fail fast at first use rather than blank
 * responses later.
 */
export function getAnthropicClient(): Anthropic {
  if (_client) return _client
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new TaggedAgentError(
      'ANTHROPIC_NOT_CONFIGURED',
      'ANTHROPIC_API_KEY missing from process.env. Add it to .env.local (Sprint 5+ requires it).',
    )
  }
  _client = new Anthropic({ apiKey })
  return _client
}

/**
 * Canonical model IDs. Sprint 1 seed already references these strings; this
 * export gives callers (Sprint 5+ agents) a typed source of truth.
 */
export const ANTHROPIC_MODELS = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
} as const
export type AnthropicModelKey = keyof typeof ANTHROPIC_MODELS
export type AnthropicModelId = (typeof ANTHROPIC_MODELS)[AnthropicModelKey]
