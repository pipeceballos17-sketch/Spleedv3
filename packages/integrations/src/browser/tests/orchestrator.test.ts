/**
 * Browser tier orchestrator tests (Sprint 9 CP2 — 7 tests).
 *
 * Exercises the escalation routing (Juan's bypass matrix) with controllable
 * fake providers, plus one end-to-end check that an unknown domain degrades
 * gracefully through the real HttpDirectProvider (Tier 1, 1 attempt, success).
 */

import { describe, expect, it } from 'bun:test'
import { BrowserOrchestrator } from '../orchestrator'
import { HttpDirectProvider } from '../providers/http-direct'
import type { BrowserProvider } from '../provider'
import type { BrowserBlockedBy, BrowserTier, ScrapeRequest, ScrapeResult } from '../types'

/**
 * A controllable provider: succeeds, or blocks with a given reason. Records
 * whether it was invoked so tests can assert which tiers ran.
 */
function fakeProvider(
  tier: BrowserTier,
  outcome: { block?: BrowserBlockedBy } = {},
  costUsd = 0,
): BrowserProvider & { calls: number } {
  return {
    tier,
    mockMode: true,
    costPerRequestUsd: costUsd,
    calls: 0,
    async scrape(_request: ScrapeRequest): Promise<ScrapeResult> {
      this.calls++
      if (outcome.block) {
        return {
          success: false,
          tierUsed: tier,
          costUsd,
          blockedBy: outcome.block,
          errorMessage: `blocked_by=${outcome.block}`,
          latencyMs: 1,
          attempts: [{ tier, costUsd, latencyMs: 1, success: false, blockedBy: outcome.block }],
        }
      }
      return {
        success: true,
        tierUsed: tier,
        costUsd,
        data: { ok: true },
        latencyMs: 1,
        attempts: [{ tier, costUsd, latencyMs: 1, success: true }],
      }
    },
  }
}

function orchestrator(providers: Array<BrowserProvider>): BrowserOrchestrator {
  return new BrowserOrchestrator({ providers: new Map(providers.map((p) => [p.tier, p])) })
}

describe('BrowserOrchestrator escalation (Sprint 9 CP2)', () => {
  it('Tier 1 → Tier 2 on cloudflare/rate_limit/unknown', async () => {
    for (const blockedBy of ['cloudflare', 'rate_limit', 'unknown'] as const) {
      const t1 = fakeProvider('http_direct', { block: blockedBy })
      const t2 = fakeProvider('vercel_browser', {}, 0.003)
      const t3 = fakeProvider('chrome_cdp_local')
      const res = await orchestrator([t1, t2, t3]).scrape({ url: 'acme.com' })
      expect(res.success).toBe(true)
      expect(res.tierUsed).toBe('vercel_browser')
      expect(t1.calls).toBe(1)
      expect(t2.calls).toBe(1)
      expect(t3.calls).toBe(0) // stopped at Tier 2
    }
  })

  it('Tier 1 → Tier 3 (skip Tier 2) on imperva/waf', async () => {
    for (const blockedBy of ['imperva', 'waf'] as const) {
      const t1 = fakeProvider('http_direct', { block: blockedBy })
      const t2 = fakeProvider('vercel_browser', {}, 0.003)
      const t3 = fakeProvider('chrome_cdp_local')
      const res = await orchestrator([t1, t2, t3]).scrape({ url: 'acme.com' })
      expect(res.success).toBe(true)
      expect(res.tierUsed).toBe('chrome_cdp_local')
      expect(t1.calls).toBe(1)
      expect(t2.calls).toBe(0) // headless skipped — won't help against Imperva/WAF
      expect(t3.calls).toBe(1)
    }
  })

  it('Tier 2 → Tier 3 on imperva/waf/cloudflare', async () => {
    for (const blockedBy of ['imperva', 'waf', 'cloudflare'] as const) {
      // Start at Tier 2 by having Tier 1 escalate to it first (cloudflare),
      // then Tier 2 itself blocks with the matrixed reason.
      const t1 = fakeProvider('http_direct', { block: 'cloudflare' })
      const t2 = fakeProvider('vercel_browser', { block: blockedBy }, 0.003)
      const t3 = fakeProvider('chrome_cdp_local')
      const res = await orchestrator([t1, t2, t3]).scrape({ url: 'acme.com' })
      expect(res.success).toBe(true)
      expect(res.tierUsed).toBe('chrome_cdp_local')
      expect(t2.calls).toBe(1)
      expect(t3.calls).toBe(1)
    }
  })

  it('blocked_by classification: geo_block/auth_required terminate, rate_limit escalates', async () => {
    // Terminal blocks — no heavier browser defeats them, so escalation stops.
    for (const terminal of ['geo_block', 'auth_required'] as const) {
      const t1 = fakeProvider('http_direct', { block: terminal })
      const t2 = fakeProvider('vercel_browser', {}, 0.003)
      const res = await orchestrator([t1, t2]).scrape({ url: 'acme.com' })
      expect(res.success).toBe(false)
      if (!res.success) expect(res.blockedBy).toBe(terminal)
      expect(t2.calls).toBe(0) // did NOT escalate
    }
    // rate_limit is transient/defeatable → escalates to Tier 2.
    const t1 = fakeProvider('http_direct', { block: 'rate_limit' })
    const t2 = fakeProvider('vercel_browser', {}, 0.003)
    const res = await orchestrator([t1, t2]).scrape({ url: 'acme.com' })
    expect(res.success).toBe(true)
    expect(t2.calls).toBe(1)
  })

  it('explicit request.tier → single tier, no escalation', async () => {
    const t1 = fakeProvider('http_direct')
    const t2 = fakeProvider('vercel_browser', { block: 'cloudflare' }, 0.003)
    const t3 = fakeProvider('chrome_cdp_local')
    const res = await orchestrator([t1, t2, t3]).scrape({ url: 'acme.com', tier: 'vercel_browser' })
    expect(res.success).toBe(false) // Tier 2 blocked and we pinned the tier
    expect(t1.calls).toBe(0)
    expect(t2.calls).toBe(1)
    expect(t3.calls).toBe(0) // no auto-escalation when tier is explicit
  })

  it('ScrapeResult.attempts[] is populated per attempt with escalated_from chain', async () => {
    const t1 = fakeProvider('http_direct', { block: 'cloudflare' })
    const t2 = fakeProvider('vercel_browser', {}, 0.003)
    const res = await orchestrator([t1, t2]).scrape({ url: 'acme.com' })
    expect(res.attempts).toHaveLength(2)
    expect(res.attempts[0]?.tier).toBe('http_direct')
    expect(res.attempts[0]?.success).toBe(false)
    expect(res.attempts[0]?.blockedBy).toBe('cloudflare')
    expect(res.attempts[1]?.tier).toBe('vercel_browser')
    expect(res.attempts[1]?.success).toBe(true)
    // total cost = sum across attempts (0 + 0.003)
    expect(res.costUsd).toBeCloseTo(0.003, 6)
  })

  it('unknown domain → synthesizeUnknownDomain graceful (Tier 1, 1 attempt, success)', async () => {
    // Real HttpDirectProvider: an unknown domain has no curated fixture, so it
    // synthesizes a thin page rather than failing — Tier 1 succeeds, no escalation.
    const t1 = new HttpDirectProvider()
    const t2 = fakeProvider('vercel_browser', {}, 0.003)
    const res = await orchestrator([t1, t2]).scrape({
      url: 'totally-unknown-domain-xyz.com',
      mockShape: 'CompanyWebsitePageContent',
    })
    expect(res.success).toBe(true)
    expect(res.tierUsed).toBe('http_direct')
    expect(res.attempts).toHaveLength(1) // matches Sprint 6b single-attempt count
    expect(res.costUsd).toBe(0)
    expect(t2.calls).toBe(0)
  })
})
