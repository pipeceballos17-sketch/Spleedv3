import type { BrowserTier, ScrapeRequest, ScrapeResult } from './types'

/**
 * A single scraping tier. Mock-default like every integration client
 * (`[TIER]_LIVE !== 'true'`). scrape() never throws for a *block* — it returns
 * a `success: false` ScrapeResult with `blockedBy`; it MAY throw for a
 * not-yet-implemented tier (Tier 3/4 stubs) so the orchestrator/worker surfaces
 * the gap loudly.
 */
export interface BrowserProvider {
  readonly tier: BrowserTier
  readonly mockMode: boolean
  /** Mock per-request cost estimate (USD). Live cost computed Sprint 9.5+. */
  readonly costPerRequestUsd: number
  scrape(request: ScrapeRequest): Promise<ScrapeResult>
}
