/**
 * Apollo.io search/enrich types. Shape is intentionally a subset of what
 * Apollo's API returns — we pick the fields Scout (Sprint 5a) and Profiler
 * (Sprint 6) actually consume. Adding fields later is additive (no migration
 * needed since fields live in TS, not the DB).
 *
 * Field naming follows Apollo's conventions (snake_case in the API; we keep
 * snake_case here to ease debugging against raw API responses, and translate
 * to camelCase only at the agent boundary if needed).
 */

export interface ApolloSearchFilters {
  /** Industry strings as Apollo classifies them (e.g. "saas", "fintech"). */
  industries?: string[]
  /** Company headcount range. */
  companySize?: { min?: number; max?: number }
  /** Free-text locations (city, region, country). Apollo normalizes internally. */
  locations?: string[]
  /** Job titles (e.g. "Founder", "CEO", "Head of Sales"). */
  titles?: string[]
  /** Seniority levels (e.g. "c_suite", "vp", "director", "manager"). */
  seniorities?: string[]
  /** Technologies the company uses (e.g. "stripe", "segment", "snowflake"). */
  technologies?: string[]
  /** Max results to return. Apollo caps at 100/page on most tiers. */
  limit?: number
}

export interface ApolloPerson {
  /** Apollo's internal person ID. Stable across calls; used for findEmail. */
  id: string
  full_name: string
  first_name: string
  last_name: string
  title: string
  /** Company name. Always populated; Apollo requires a current employer for ranking. */
  company: string
  company_domain?: string
  /** Apollo's industry classification (single string, lowercase tag). */
  industry?: string
  /** Headcount estimate at the company. */
  company_size?: number
  /** Free-text location string. */
  location?: string
  /** Reported tech stack at the company. */
  technologies?: string[]
  /** Apollo's seniority bucket (matches search filter values). */
  seniority?: string

  // Contact channels — may be null on free-tier search; findEmail unlocks email.
  email?: string | null
  linkedin_url?: string | null
  x_handle?: string | null
  github_handle?: string | null
}

export interface ApolloSearchResult {
  candidates: ApolloPerson[]
  /** Total Apollo says match the filter — may exceed candidates.length when paginated. */
  totalFound: number
  /** Credits Apollo deducted from the tenant's account for this call. */
  creditsConsumed: number
}

export interface ApolloEmailResult {
  email: string | null
  /** 0-1 confidence Apollo attaches to the deliverability of this email. */
  confidence: number
  creditsConsumed: number
}
