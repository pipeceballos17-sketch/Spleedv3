/**
 * Vercel agent-browser types — Profiler's company website + news source
 * (Sprint 6 decisions 1 & 7: Vercel for zero-ToS-risk scraping; Apify
 * reserved for LinkedIn which has stronger anti-bot defenses).
 *
 * Sprint 6a wires only `scrapeCompanyWebsite`. Sprint 6b adds
 * `scrapeNewsArticle` (Google News results) and screenshot capture for
 * hook moments.
 *
 * Field naming: camelCase (the real Vercel agent-browser SDK is JS-native).
 */

export interface CompanyWebsitePageContent {
  /** <title> tag content or H1 fallback. */
  title: string
  /**
   * Primary text content extracted from the landing page. Whitespace
   * normalized, navigation/footer stripped. Capped at ~3000 chars so
   * extraction prompts stay within budget.
   */
  mainText: string
  /** /about (or /company) page text if discoverable. */
  aboutText?: string
  /** /team (or /people) page text if discoverable. */
  teamText?: string
  /** /news, /blog, /press landing text if discoverable. */
  newsText?: string
}

export interface CompanyWebsiteScrapeMetadata {
  /** Final URL after redirects. */
  finalUrl: string
  /** HTTP status code at final URL. */
  statusCode: number
  /** Total time spent scraping (load + content extraction). */
  loadTimeMs: number
}

export interface CompanyWebsiteScrapeResult {
  pageContent: CompanyWebsitePageContent
  metadata: CompanyWebsiteScrapeMetadata
  /** Vercel agent-browser session credits (mock: 1 per scrape). */
  creditsConsumed: number
  /** Billed cost in USD (mock: $0.003 per scrape per Sprint 6 cost breakdown). */
  costUsd: number
}
