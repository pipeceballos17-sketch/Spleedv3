/**
 * AnthropicClient composer-method tests (Sprint 8.2 — 2 tests).
 *
 * Client-layer unit tests (no DB / agents). The ComposerAgent end-to-end is
 * covered in @spleed/agents composer.test.ts.
 */

import { describe, expect, it } from 'bun:test'
import { AnthropicClient } from '../client'

const client = new AnthropicClient({ apiKey: 'mock', mockMode: true })

describe('AnthropicClient.recommendChannel (Sprint 8.2)', () => {
  it('channel fallback (iMessage ICP, no phone → email) + manual_lookup when no contact', async () => {
    // Channel mismatch: ICP default iMessage, but only an email is on file →
    // Phase 0 overrides to email and explains why.
    const fallback = await client.recommendChannel({
      systemPrompt: 's',
      userPrompt: 'u',
      preferredChannel: 'imessage',
      contactData: { email: 'sarah@pulseanalytics.io', phone: null, linkedinUrl: null },
      domainHint: 'pulseanalytics.io',
    })
    expect(fallback.recommendation.channel).toBe('email')
    expect(fallback.recommendation.reasoning.toLowerCase()).toMatch(/phone|fall/)
    expect(fallback.contactData.email).toBe('sarah@pulseanalytics.io')
    expect(fallback.costUsd).toBeGreaterThan(0)
    expect(fallback.tokensIn).toBe(800)
    expect(fallback.tokensOut).toBe(200)

    // No email and no phone → manual lookup required (short-circuits compose).
    const manual = await client.recommendChannel({
      systemPrompt: 's',
      userPrompt: 'u',
      preferredChannel: 'email',
      contactData: { email: null, phone: null, linkedinUrl: 'https://linkedin.com/in/x' },
    })
    expect(manual.recommendation.channel).toBe('manual_lookup_required')
  })
})

describe('AnthropicClient composer mock determinism (Sprint 8.2)', () => {
  it('same input → identical hook/draft/channel output across invocations', async () => {
    const base = { systemPrompt: 's', userPrompt: 'u', domainHint: 'pulseanalytics.io' } as const

    const [h1, h2, h3] = await Promise.all([
      client.selectHook(base),
      client.selectHook(base),
      client.selectHook(base),
    ])
    expect(h1.selectedHooks).toEqual(h2.selectedHooks)
    expect(h2.selectedHooks).toEqual(h3.selectedHooks)
    expect(h1.costUsd).toBe(h3.costUsd)

    const d1 = await client.composeDraft({ ...base, channel: 'email' })
    const d2 = await client.composeDraft({ ...base, channel: 'email' })
    expect(d1.draft).toEqual(d2.draft)
    expect(d1.latencyMs).toBe(d2.latencyMs)

    const c1 = await client.recommendChannel({ ...base, preferredChannel: 'email', contactData: { email: 'a@b.com' } })
    const c2 = await client.recommendChannel({ ...base, preferredChannel: 'email', contactData: { email: 'a@b.com' } })
    expect(c1.recommendation).toEqual(c2.recommendation)
  })
})
