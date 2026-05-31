/**
 * Browser tier framework types (Sprint 9 CP2 — BACKLOG-057, Juan's bypass
 * matrix). A tiered scraping abstraction: cheap HTTP-direct first, escalating
 * to heavier (and costlier) browser tiers only when an anti-bot block demands
 * it.
 *
 * Leaf package: NO @spleed/db dependency. Providers return cost/tier metadata
 * in ScrapeResult; the calling worker (Profiler) writes the cost_events.
 */

/** Scraping tiers, cheapest → heaviest. */
export type BrowserTier =
  | 'http_direct' // Tier 1 — plain fetch (free)
  | 'vercel_browser' // Tier 2 — Vercel agent-browser (headless Chromium)
  | 'chrome_cdp_local' // Tier 3 — local Chrome over CDP (Sprint 9.5+, BACKLOG-057)
  | 'browser_farm_managed' // Tier 4 — managed farm (Sprint 10+, BrowserBase/Bright Data)

/** What blocked a scrape attempt — drives tier escalation routing. */
export type BrowserBlockedBy =
  | 'cloudflare'
  | 'imperva'
  | 'waf'
  | 'geo_block'
  | 'rate_limit'
  | 'auth_required'
  | 'unknown'

export interface ScrapeRequest {
  /** Target URL or bare domain (providers normalize). */
  url: string
  /** Force a specific tier (no auto-escalation). Omit to start Tier 1 + escalate. */
  tier?: BrowserTier
  /** Tier 2+ — CSS selector to await before extracting (live mode). */
  waitForSelector?: string
  /**
   * Structured-extraction schema (a Zod schema). Unused in Sprint 9 CP2 mock
   * (the Profiler runs LLM extraction separately on the returned page content);
   * reserved for Sprint 9.5+ live structured extraction. Typed `unknown` to
   * keep this contract zod-agnostic.
   */
  extractSchema?: unknown
  /** Default 30000ms. */
  timeoutMs?: number
  /**
   * Identifies which curated mock fixture to return in mock mode. Sprint 9 CP2
   * supports only the company-website shape; Sprint 10+ extends to others.
   */
  mockShape?: 'CompanyWebsitePageContent'
}

/** One tier attempt — the worker turns each into a cost_event. */
export interface ScrapeAttempt {
  tier: BrowserTier
  costUsd: number
  latencyMs: number
  success: boolean
  /** Set when success=false. */
  blockedBy?: BrowserBlockedBy
}

/**
 * Discriminated scrape outcome. `costUsd` is the TOTAL across all attempts
 * (escalation included); `attempts` carries the per-tier breakdown so the
 * worker logs one cost_event per attempt. `data` is the scraped payload
 * (a CompanyWebsitePageContent for mockShape='CompanyWebsitePageContent');
 * the caller casts to the expected shape.
 */
export type ScrapeResult =
  | {
      success: true
      tierUsed: BrowserTier
      costUsd: number
      data: unknown
      latencyMs: number
      attempts: ScrapeAttempt[]
    }
  | {
      success: false
      tierUsed: BrowserTier
      costUsd: number
      blockedBy: BrowserBlockedBy
      errorMessage: string
      latencyMs: number
      attempts: ScrapeAttempt[]
    }
