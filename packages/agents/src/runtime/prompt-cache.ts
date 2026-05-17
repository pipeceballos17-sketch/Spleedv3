import { TaggedAgentError } from './errors'

/**
 * Prompt-cache TTL. Sprint 3 supports only `ephemeral` (5-minute Anthropic
 * cache). The signature accepts a TTL parameter so Sprint 5+ can introduce
 * `persistent` (1h) per-agent overrides without breaking call sites.
 */
export type CacheTTL = 'ephemeral' | 'persistent'

/**
 * Local text-block shape with `cache_control`. The Anthropic API accepts this
 * at runtime (prompt caching went GA in 2024), but the TS types in
 * @anthropic-ai/sdk@0.30.1 don't expose `cache_control` on `TextBlockParam`
 * yet. We build a `CachedTextBlock` here and cast to the API's expected type
 * at the boundary in `runtime/index.ts`. Sprint 5+ can drop the local type if
 * the SDK catches up.
 */
export interface CachedTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

/**
 * Wrap a text block with the appropriate `cache_control` breakpoint. Anthropic
 * caches everything up to and including this breakpoint; subsequent calls with
 * an identical prefix re-use the cache (~90% input cost reduction).
 *
 * Usage in runAgent:
 *   system: [withCacheControl(systemPrompt, 'ephemeral')]
 *
 * For Sprint 3, only `ephemeral` is implemented. Calling with `persistent`
 * throws a TaggedAgentError so misuse fails loudly.
 */
export function withCacheControl(
  text: string,
  ttl: CacheTTL = 'ephemeral',
): CachedTextBlock {
  if (ttl !== 'ephemeral') {
    throw new TaggedAgentError(
      'PROMPT_CACHE_TTL_UNSUPPORTED',
      `Cache TTL "${ttl}" is not supported in Sprint 3. Only "ephemeral" (5min) is wired up.`,
      { context: { requestedTtl: ttl } },
    )
  }
  return {
    type: 'text',
    text,
    cache_control: { type: 'ephemeral' },
  }
}
