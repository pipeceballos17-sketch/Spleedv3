import type { BrowserProvider } from '../provider'
import type { BrowserTier, ScrapeRequest, ScrapeResult } from '../types'

/**
 * Tier 4 — managed browser farm (BrowserBase / Bright Data, BYOK). The last
 * resort for the hardest targets. Deferred to Sprint 10+; the stub throws.
 */
export class BrowserFarmManagedProvider implements BrowserProvider {
  readonly tier: BrowserTier = 'browser_farm_managed'
  readonly mockMode = true
  readonly costPerRequestUsd = 0.1

  async scrape(_request: ScrapeRequest): Promise<ScrapeResult> {
    throw new Error(
      '[browser:browser_farm_managed] Tier 4 deferred Sprint 10+ (BrowserBase / Bright Data BYOK)',
    )
  }
}
