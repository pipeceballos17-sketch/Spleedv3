/**
 * Apify integration types — Profiler's LinkedIn source (Sprint 6b decision 1
 * & 2: profile + posts paralelo, single Spleed-managed Apify account in
 * Sprint 6b/MVP; per-tenant BYOK deferred to BACKLOG-041 Phase 2).
 *
 * Sprint 6b wires the LinkedIn profile + posts actors. Sprint 6b+ can add
 * Sales Navigator (BACKLOG-039 enterprise tier) or other Apify actors
 * (Reddit, X, GitHub) as Profiler sources grow beyond the 3-source MVP.
 *
 * Field naming: camelCase (Apify's SDK normalizes its varied actor output
 * shapes into JS-native objects; we settle on the consumer-friendly form).
 */

export interface LinkedinPosition {
  title: string
  company: string
  /** ISO month string `YYYY-MM`. Day omitted since LinkedIn rarely surfaces it. */
  startDate: string
  /** Absent when this is the lead's current role. */
  endDate?: string
  description?: string
}

export interface LinkedinEducation {
  institution: string
  degree?: string
  field?: string
  /** Free-text year range, e.g. `"2014-2018"`. Apify normalizes to this. */
  years?: string
}

export interface LinkedinProfile {
  fullName: string
  headline: string
  /**
   * Sprint 9 — contact phone when the profile/contact-info surfaces one.
   * Mock returns curated values; live mode (Sprint 9+) reads the Apify
   * contact-info actor's `contact.phone`. Raw form — Profiler normalizes to
   * E.164 before persisting to leads.phone.
   */
  phone?: string
  /** Most recent role with no endDate. Absent for retired or job-hunting profiles. */
  currentPosition?: LinkedinPosition
  /** Reverse-chronological. Most recent first. */
  experience: LinkedinPosition[]
  education: LinkedinEducation[]
  skills: string[]
  about?: string
  location?: string
  /** Coarse-rounded by LinkedIn at >500 / >1K / >10K tiers. */
  connectionsCount?: number
}

export interface ApifyLinkedinProfileScrapeResult {
  profile: LinkedinProfile
  metadata: {
    profileUrl: string
    scrapedAt: string
  }
  /** Mock: ~$0.075 (mid of Apify's $0.05-0.08 real-tier rate per profile). */
  costUsd: number
}

export interface LinkedinPost {
  id: string
  /** ISO timestamp string. */
  postedAt: string
  content: string
  reactions: number
  comments: number
  url: string
}

export interface ApifyLinkedinPostsScrapeOptions {
  /** Cap posts returned. Default 10. */
  limit?: number
  /** Only fetch posts newer than this many days. Default 90. */
  sinceDays?: number
}

export interface ApifyLinkedinPostsScrapeResult {
  posts: LinkedinPost[]
  metadata: {
    profileUrl: string
    postsCount: number
    scrapedAt: string
  }
  /** Mock: ~$0.025 (mid of $0.02-0.03 real-tier rate per posts call). */
  costUsd: number
}
