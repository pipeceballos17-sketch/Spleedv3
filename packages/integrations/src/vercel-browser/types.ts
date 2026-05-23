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

// ─── Sprint 6b — Google News source (3rd Profiler source) ──────────

export interface NewsArticle {
  title: string
  /** Canonical article URL after publisher redirects. */
  url: string
  /** Publisher name (e.g. "TechCrunch", "Bloomberg"). */
  source: string
  /** ISO timestamp of publication, as reported by Google News. */
  publishedAt: string
  /** Snippet/lead surfaced by Google News results page. */
  snippet: string
  /** Optional 0-1 relevance score Google News assigns to the query match. */
  relevanceScore?: number
}

export interface GoogleNewsScrapeOptions {
  /** Filter to articles within the last N days. Default 90. */
  daysBack?: number
  /** Cap results returned. Default 10. */
  maxResults?: number
}

export interface GoogleNewsScrapeResult {
  articles: NewsArticle[]
  metadata: {
    /** Original query string (typically `${company} OR ${domain}`). */
    query: string
    resultsCount: number
    scrapedAt: string
  }
  /** Mock: ~$0.002 (Google News scrape is lightweight vs full-site crawl). */
  costUsd: number
}

// ─── Sprint 6b — Annotated screenshots for hook evidence ──────────

export interface TakeAnnotatedScreenshotInput {
  /** Page to capture. Browser session re-uses an open tab when available. */
  url: string
  /**
   * CSS selector or agent-browser element reference (`@e3` etc.) for the
   * element to highlight. Omitted → full-page screenshot.
   */
  selector?: string
  /**
   * If true, the agent-browser draws a highlight box + caption around the
   * matched element before screenshotting. Default true.
   */
  annotate?: boolean
}

export interface AnnotatedScreenshotResult {
  /** Raw PNG bytes (or mock placeholder bytes — Buffer in Bun/Node). */
  imageBytes: Buffer
  mimeType: 'image/png'
  /** Mock: ~$0.001 (single render is cheap vs full scrape). */
  costUsd: number
}
