import type { BrowserProvider } from '../provider'
import type { BrowserTier, ScrapeRequest, ScrapeResult } from '../types'
import { mockScrapeCompanyWebsite, synthesizeUnknownDomain } from '../../vercel-browser/mock'

/** Strip protocol/path to a bare lowercase domain for mock lookup + metadata. */
export function urlToDomain(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
}

/** Deterministic mock latency band (~150-450ms) — fast tier, no clock dep. */
function mockLatency(url: string): number {
  const sum = [...url].reduce((a, c) => a + c.charCodeAt(0), 0)
  return 150 + (sum % 300)
}

/**
 * Tier 1 — plain HTTP fetch. Free, fastest, but defeated by any real anti-bot
 * (Cloudflare / Imperva / WAF). Mock-default reuses the curated Sprint 6b
 * company-website fixtures (Sprint 9 CP1 contactPhone preserved). Live wiring
 * (Sprint 9.5+) does the fetch + challenge detection.
 */
export class HttpDirectProvider implements BrowserProvider {
  readonly tier: BrowserTier = 'http_direct'
  readonly mockMode: boolean
  readonly costPerRequestUsd = 0

  constructor(mockMode?: boolean) {
    this.mockMode = mockMode ?? process.env.HTTP_DIRECT_LIVE !== 'true'
  }

  async scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    if (this.mockMode) return this.scrapeMock(request)
    return this.scrapeLive(request)
  }

  private async scrapeMock(request: ScrapeRequest): Promise<ScrapeResult> {
    const latencyMs = mockLatency(request.url)
    const attempt = { tier: this.tier, costUsd: 0, latencyMs, success: true as const }

    // Sprint 9 CP2 supports the company-website shape only. Unknown domains
    // fall back to a thin synthesized page (graceful — matches Sprint 6b), so
    // Tier 1 succeeds rather than escalating on a missing fixture.
    if (request.mockShape === 'CompanyWebsitePageContent') {
      const domain = urlToDomain(request.url)
      const scrape = mockScrapeCompanyWebsite(domain) ?? synthesizeUnknownDomain(domain)
      return { success: true, tierUsed: this.tier, costUsd: 0, data: scrape.pageContent, latencyMs, attempts: [attempt] }
    }

    // Unknown shape in mock → treat as a soft failure (caller can escalate).
    return {
      success: false, tierUsed: this.tier, costUsd: 0, blockedBy: 'unknown',
      errorMessage: `Unsupported mockShape: ${request.mockShape ?? 'none'}`, latencyMs,
      attempts: [{ ...attempt, success: false, blockedBy: 'unknown' }],
    }
  }

  private async scrapeLive(_request: ScrapeRequest): Promise<ScrapeResult> {
    // Sprint 9.5+: fetch(url, { signal: AbortSignal.timeout(timeoutMs) }) then
    // classify blocks before returning success:
    //   - Cloudflare:  HTML has 'cf-browser-verification' / 'Just a moment...'
    //   - Imperva:     'incap_ses_*' cookie OR 'Incapsula incident' in HTML
    //   - WAF:         403 + akamai/aws-waf headers OR challenge page
    //   - geo_block:   status 451 OR 'not available in your country'
    //   - rate_limit:  status 429
    // On block → { success:false, blockedBy }. Else apply extractSchema → data.
    throw new Error(
      '[browser:http_direct] live mode not implemented in Sprint 9 CP2 — wire fetch + challenge detection in Sprint 9.5+ (BACKLOG-057)',
    )
  }
}
