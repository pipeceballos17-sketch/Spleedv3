import type { BrowserProvider } from '../provider'
import type { BrowserTier, ScrapeRequest, ScrapeResult } from '../types'

/**
 * Tier 3 — local Chrome over CDP. Juan Ortega's bypass matrix proved this
 * clears Imperva / WAF / some Cloudflare that headless Vercel can't. Deferred
 * to Sprint 9.5+ (BACKLOG-057, collaborative design with Juan); the stub
 * throws so any escalation that reaches it surfaces the gap loudly rather than
 * silently returning a failure.
 */
export class ChromeCdpLocalProvider implements BrowserProvider {
  readonly tier: BrowserTier = 'chrome_cdp_local'
  readonly mockMode = true
  readonly costPerRequestUsd = 0

  async scrape(_request: ScrapeRequest): Promise<ScrapeResult> {
    throw new Error(
      '[browser:chrome_cdp_local] Tier 3 deferred Sprint 9.5+ (BACKLOG-057, Juan bypass matrix collaborative)',
    )
  }
}
