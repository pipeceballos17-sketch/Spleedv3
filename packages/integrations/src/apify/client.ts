import type {
  ApifyLinkedinPostsScrapeOptions,
  ApifyLinkedinPostsScrapeResult,
  ApifyLinkedinProfileScrapeResult,
} from './types'
import {
  mockScrapeLinkedinPosts,
  mockScrapeLinkedinProfile,
  synthesizeEmptyPosts,
  synthesizeUnknownProfile,
} from './mock'

export interface ApifyClientConfig {
  /**
   * Apify API token. Sprint 6b/MVP uses a single Spleed-managed account
   * (env APIFY_TOKEN); per-tenant BYOK is deferred to BACKLOG-041 (Phase 2,
   * Sprint 13+) once enterprise tier validates the operational complexity.
   */
  token?: string
  /**
   * Force mock mode. When omitted, defaults to
   * `process.env.APIFY_LIVE !== 'true'`, i.e. mock-by-default. Sprint 6b
   * ships only the mock path; toggle APIFY_LIVE=true to hit the explicit
   * Sprint 7+ throw — wiring the real apify-client SDK lands when
   * concierge customers come online.
   */
  mockMode?: boolean
}

function isMockByDefault(): boolean {
  return process.env.APIFY_LIVE !== 'true'
}

/**
 * Apify client — Profiler's LinkedIn source (Sprint 6b decision 1).
 * Wraps the LinkedIn profile + posts community actors. Mock-default so
 * test runs and CI never consume real Apify credits; pass
 * `{ mockMode: false }` or set APIFY_LIVE=true to exercise the real
 * client path (currently throws loud — Sprint 7+ wires the real Apify
 * Node SDK once concierge customers come online).
 *
 * Sprint 6b ships scrapeLinkedinProfile + scrapeLinkedinPosts. Sprint
 * 7+ may add Reddit, X, GitHub actors as Profiler sources expand
 * beyond the 3-source MVP (company website + LinkedIn + news).
 */
export class ApifyClient {
  private readonly _token?: string
  private readonly mockMode: boolean

  constructor(config: ApifyClientConfig = {}) {
    this._token = config.token ?? process.env.APIFY_TOKEN
    this.mockMode = config.mockMode ?? isMockByDefault()

    if (this.mockMode && process.env.NODE_ENV !== 'test') {
      console.log('[apify] MOCK MODE ACTIVE — set APIFY_LIVE=true to use real Apify')
    }
  }

  /**
   * Scrape a LinkedIn profile via the apify/linkedin-profile-scraper
   * actor. Returns identity + experience + education + skills + about
   * + connections.
   *
   * Mock mode: looks up by URL against MOCK_PROFILES; unknown URLs
   * receive a deterministic empty profile (graceful degradation —
   * Profiler should still produce a valid empty-signal dossier).
   */
  async scrapeLinkedinProfile(linkedinUrl: string): Promise<ApifyLinkedinProfileScrapeResult> {
    if (this.mockMode) {
      return this.scrapeLinkedinProfileMock(linkedinUrl)
    }
    return this.scrapeLinkedinProfileLive(linkedinUrl)
  }

  /**
   * Scrape a profile's recent posts via apify/linkedin-posts-scraper.
   * Bounded by `sinceDays` (default 90) and `limit` (default 10).
   *
   * Mock mode: curated post fixtures per profile; unknown profiles
   * receive an empty post list.
   */
  async scrapeLinkedinPosts(
    linkedinUrl: string,
    options: ApifyLinkedinPostsScrapeOptions = {},
  ): Promise<ApifyLinkedinPostsScrapeResult> {
    if (this.mockMode) {
      return this.scrapeLinkedinPostsMock(linkedinUrl, options)
    }
    return this.scrapeLinkedinPostsLive(linkedinUrl, options)
  }

  // ─── Mock implementations ────────────────────────────────────────

  private async scrapeLinkedinProfileMock(url: string): Promise<ApifyLinkedinProfileScrapeResult> {
    const result = mockScrapeLinkedinProfile(url)
    if (result) return result
    return synthesizeUnknownProfile(url)
  }

  private async scrapeLinkedinPostsMock(
    url: string,
    options: ApifyLinkedinPostsScrapeOptions,
  ): Promise<ApifyLinkedinPostsScrapeResult> {
    const result = mockScrapeLinkedinPosts(url, options)
    if (result) return result
    return synthesizeEmptyPosts(url)
  }

  // ─── Live implementations (stubs for Sprint 6b) ──────────────────

  private async scrapeLinkedinProfileLive(
    _url: string,
  ): Promise<ApifyLinkedinProfileScrapeResult> {
    // Sprint 7+: wire to apify-client SDK using this._token. Actor:
    // `apify/linkedin-profile-scraper`. Returns dataset items; normalize
    // shape into LinkedinProfile before returning.
    throw new Error(
      '[apify] live mode not implemented in Sprint 6b — wire real Apify client in Sprint 7+ when concierge customers come online',
    )
  }

  private async scrapeLinkedinPostsLive(
    _url: string,
    _options: ApifyLinkedinPostsScrapeOptions,
  ): Promise<ApifyLinkedinPostsScrapeResult> {
    // Sprint 7+: wire to apify-client SDK using this._token. Actor:
    // `apify/linkedin-posts-scraper`. Filter by sinceDays + limit before
    // returning.
    throw new Error(
      '[apify] live mode not implemented in Sprint 6b — wire real Apify client in Sprint 7+ when concierge customers come online',
    )
  }
}
