import { describe, expect, it } from 'bun:test'
import { TaggedAgentError, withCacheControl } from '../runtime'

describe('prompt-cache helper', () => {
  it('wraps text with ephemeral cache_control by default', () => {
    const block = withCacheControl('system prompt body')
    expect(block.type).toBe('text')
    expect(block.text).toBe('system prompt body')
    expect(block.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('throws TaggedAgentError for unsupported TTL (persistent)', () => {
    let caught: TaggedAgentError | null = null
    try {
      withCacheControl('hello', 'persistent')
    } catch (err) {
      caught = err as TaggedAgentError
    }
    expect(caught).not.toBeNull()
    expect(caught?.tag).toBe('PROMPT_CACHE_TTL_UNSUPPORTED')
  })
})

describe('TaggedAgentError', () => {
  it('classifies transient and permanent correctly', () => {
    const transient = new TaggedAgentError('TEST_TRANSIENT', 'transient', { classification: 'transient' })
    expect(transient.transient).toBe(true)
    expect(transient.classification).toBe('transient')

    const permanent = new TaggedAgentError('TEST_PERMANENT', 'permanent')
    expect(permanent.transient).toBe(false)
    expect(permanent.classification).toBe('permanent')
  })

  it('preserves context payload', () => {
    const err = new TaggedAgentError('CTX_TEST', 'with context', {
      context: { retryAfterSeconds: 60, provider: 'apollo' },
    })
    expect(err.context).toEqual({ retryAfterSeconds: 60, provider: 'apollo' })
  })
})

// ---------------------------------------------------------------------
// Live Anthropic smoke test — only runs if ANTHROPIC_API_KEY is set.
// Costs ~$0.0001 per run (one tiny Haiku call). Skipped in CI without key.
// ---------------------------------------------------------------------

const HAS_ANTHROPIC = Boolean(process.env.ANTHROPIC_API_KEY)
const smoke = HAS_ANTHROPIC ? describe : describe.skip

smoke('Anthropic SDK smoke (requires ANTHROPIC_API_KEY)', () => {
  it('makes a minimal Haiku call and returns text content', async () => {
    const { getAnthropicClient, ANTHROPIC_MODELS } = await import('../runtime')
    const client = getAnthropicClient()
    const response = await client.messages.create({
      model: ANTHROPIC_MODELS.haiku,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly: PING' }],
    })
    expect(response.content.length).toBeGreaterThan(0)
    expect(response.stop_reason).toBeDefined()
  }, 30_000)
})
