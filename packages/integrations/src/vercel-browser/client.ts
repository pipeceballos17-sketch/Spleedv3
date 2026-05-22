import type { CompanyWebsiteScrapeResult } from './types'
import { mockScrapeCompanyWebsite, synthesizeUnknownDomain } from './mock'

export interface VercelBrowserClientConfig {
  /**
   * Vercel agent-browser API key. Per-tenant in production via Vault
   * once concierge customers come online (Sprint 7+). Sprint 6a reads
   * it but never sends a real request.
   */
  apiKey?: string
  /**
   * Force mock mode. When omitted, defaults to
   * `process.env.VERCEL_BROWSER_LIVE !== 'true'`, i.e. mock-by-default.
   * Set VERCEL_BROWSER_LIVE=true in `.env.local` to exercise the real
   * client (Sprint 7+ wires it; today the live path throws loud — matches
   * the Apollo (Sprint 5a) and Anthropic (Sprint 5b) defer pattern).
   */
  mockMode?: boolean
}

function isMockByDefault(): boolean {
  return process.env.VERCEL_BROWSER_LIVE !== 'true'
}

/**
 * Vercel agent-browser client — Profiler's company-website + (Sprint 6b)
 * Google-News scraper. Mock-default so test runs and CI never burn browser
 * session credits; pass `{ mockMode: false }` or set VERCEL_BROWSER_LIVE=true
 * to exercise the real client path (currently throws loud — Sprint 7 wires
 * the real Vercel agent-browser SDK once concierge customers come online).
 *
 * Sprint 6a: scrapeCompanyWebsite only. Sprint 6b adds scrapeNewsArticle
 * + screenshot capture for annotated hook moments (BACKLOG-038 deferred,
 * BACKLOG-039 Sales Nav enterprise path).
 */
export class VercelBrowserClient {
  // apiKey kept for the live path; Sprint 6a never reads it.
  // Underscore prefix signals "intentionally unused for now" to readers.
  private readonly _apiKey?: string
  private readonly mockMode: boolean

  constructor(config: VercelBrowserClientConfig = {}) {
    this._apiKey = config.apiKey
    this.mockMode = config.mockMode ?? isMockByDefault()

    if (this.mockMode && process.env.NODE_ENV !== 'test') {
      // Visible at every instantiation so dev never silently exercises mocks
      // thinking they're hitting Vercel agent-browser. Quiet during tests.
      console.log(
        '[vercel-browser] MOCK MODE ACTIVE — set VERCEL_BROWSER_LIVE=true to use real Vercel agent-browser',
      )
    }
  }

  /**
   * Scrape a company website's landing + (if discoverable) /about, /team,
   * /news pages. Returns normalized pageContent and billing metadata.
   *
   * Mock mode: looks up by domain against MOCK_COMPANY_WEBSITES; unknown
   * domains receive a deterministic thin result (graceful degradation —
   * Profiler should still produce empty-but-valid signals).
   */
  async scrapeCompanyWebsite(url: string): Promise<CompanyWebsiteScrapeResult> {
    if (this.mockMode) {
      return this.scrapeCompanyWebsiteMock(url)
    }
    return this.scrapeCompanyWebsiteLive(url)
  }

  // ─── Mock implementation ─────────────────────────────────────────────

  private async scrapeCompanyWebsiteMock(url: string): Promise<CompanyWebsiteScrapeResult> {
    const result = mockScrapeCompanyWebsite(url)
    if (result) return result
    return synthesizeUnknownDomain(url)
  }

  // ─── Live implementation (stub for Sprint 6a) ───────────────────────

  private async scrapeCompanyWebsiteLive(_url: string): Promise<CompanyWebsiteScrapeResult> {
    // Sprint 7+: wire to the real Vercel agent-browser session API once
    // concierge customers come online. Until then, hard-fail loud so anyone
    // toggling VERCEL_BROWSER_LIVE=true knows the live path isn't built.
    throw new Error(
      '[vercel-browser] live mode not implemented in Sprint 6a — wire real Vercel agent-browser in Sprint 7+ when concierge customers come online',
    )
  }
}
