/**
 * Tier 2 browser provider (Sprint 9 CP2) — adapts the existing
 * VercelBrowserClient to the BrowserProvider interface. The client + mock +
 * types are UNTOUCHED (backward compat): other code paths still import
 * VercelBrowserClient directly. This provider only adds the tier-framework
 * adapter so the orchestrator can escalate Tier 1 → Tier 2.
 *
 * Headless Chromium clears basic Cloudflare but not Imperva/WAF (the
 * orchestrator escalates those to Tier 3).
 */

import type { BrowserProvider } from '../browser/provider'
import type { BrowserTier, ScrapeRequest, ScrapeResult } from '../browser/types'
import { VercelBrowserClient } from './client'

/** Mock cost mirrors the existing vercel mock ($0.003/scrape), not the plan's
 * 0.02 estimate — keeps tier cost_events consistent with Sprint 6b figures. */
const VERCEL_MOCK_COST_USD = 0.003

export class VercelBrowserProvider implements BrowserProvider {
  readonly tier: BrowserTier = 'vercel_browser'
  readonly mockMode: boolean
  readonly costPerRequestUsd = VERCEL_MOCK_COST_USD
  private readonly client: VercelBrowserClient

  constructor(client?: VercelBrowserClient, mockMode?: boolean) {
    this.client = client ?? new VercelBrowserClient()
    this.mockMode = mockMode ?? process.env.VERCEL_BROWSER_LIVE !== 'true'
  }

  async scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    const startMs = Date.now()
    if (request.mockShape !== 'CompanyWebsitePageContent') {
      return {
        success: false, tierUsed: this.tier, costUsd: 0, blockedBy: 'unknown',
        errorMessage: `Unsupported mockShape: ${request.mockShape ?? 'none'}`, latencyMs: 0,
        attempts: [{ tier: this.tier, costUsd: 0, latencyMs: 0, success: false, blockedBy: 'unknown' }],
      }
    }

    // The client is itself mock-default (VERCEL_BROWSER_LIVE) and normalizes the
    // domain. Live mode (Sprint 9.5+) adds post-render block detection here.
    const scrape = await this.client.scrapeCompanyWebsite(request.url)
    const latencyMs = Date.now() - startMs
    const costUsd = scrape.costUsd
    return {
      success: true,
      tierUsed: this.tier,
      costUsd,
      data: scrape.pageContent,
      latencyMs,
      attempts: [{ tier: this.tier, costUsd, latencyMs, success: true }],
    }
  }
}
