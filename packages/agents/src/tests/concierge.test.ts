/**
 * Concierge parser test suite (Sprint 7c — 4 tests).
 *
 * Pure unit tests over parseConciergeQuery against the mock Anthropic client
 * (Haiku-pinned). No DB / Redis — the parser is a deterministic transform
 * from founder text → IngestPayload. End-to-end worker orchestration
 * (ack → ingest → card) is covered in profiler.test.ts (Sprint 7c slice) +
 * slack-events/slack-oauth API tests.
 */

import { describe, expect, it } from 'bun:test'
import { AnthropicClient } from '@spleed/integrations/anthropic'
import { parseConciergeQuery } from '../agents/concierge'

const anthropic = new AnthropicClient({ apiKey: 'mock', mockMode: true })

describe('parseConciergeQuery — Sprint 7c', () => {
  it('English happy path: "who is Sarah Chen from PulseAnalytics"', async () => {
    const r = await parseConciergeQuery({
      text: 'who is Sarah Chen from PulseAnalytics',
      anthropicClient: anthropic,
    })
    expect(r.parseSucceeded).toBe(true)
    expect(r.payload.name).toBe('Sarah Chen')
    expect(r.payload.companyDomain).toBe('pulseanalytics.com')
    // No LinkedIn URL in the query → field omitted (not null) so it matches
    // IngestPayloadSchema's `.optional()` contract.
    expect(r.payload.linkedinUrl).toBeUndefined()
    expect(r.errorReason).toBeUndefined()
  })

  it('Spanish multilingual: "quien es Laura del Liceo Cervantes"', async () => {
    const r = await parseConciergeQuery({
      text: 'quien es Laura del Liceo Cervantes',
      anthropicClient: anthropic,
    })
    expect(r.parseSucceeded).toBe(true)
    expect(r.payload.name).toBe('Laura')
    // Domain inferred from context; .edu.co TLD for an educational keyword.
    expect(r.payload.companyDomain).toBe('liceocervantes.edu.co')
    // Language flagged in notes so downstream agents adapt tone.
    expect(r.payload.notes).toBe('Spanish query')
  })

  it('ambiguous query → parseSucceeded=false + errorReason populated', async () => {
    const r = await parseConciergeQuery({
      text: 'lol who knows',
      anthropicClient: anthropic,
    })
    expect(r.parseSucceeded).toBe(false)
    expect(r.errorReason).toBeTruthy()
    // Empty payload — nothing identifiable surfaced.
    expect(r.payload.name).toBeUndefined()
    expect(r.payload.companyDomain).toBeUndefined()
    expect(r.payload.linkedinUrl).toBeUndefined()
  })

  it('cost + token tracking on the Haiku rate', async () => {
    const r = await parseConciergeQuery({
      text: 'who is Sarah Chen from PulseAnalytics',
      anthropicClient: anthropic,
    })
    expect(r.tokensIn).toBe(500)
    expect(r.tokensOut).toBe(80)
    // Haiku 4.5: 500/1e6 * $1 + 80/1e6 * $5 = $0.0005 + $0.0004 = $0.0009.
    // Pinned to Haiku regardless of the client's default model.
    expect(r.costUsd).toBeGreaterThan(0)
    expect(r.costUsd).toBeCloseTo(0.0009, 5)
    expect(r.latencyMs).toBeGreaterThan(0)
  })
})
