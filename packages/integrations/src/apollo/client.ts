import type {
  ApolloEmailResult,
  ApolloPerson,
  ApolloSearchFilters,
  ApolloSearchResult,
} from './types'
import { MOCK_CANDIDATES, filterMockCandidates } from './mock'

export interface ApolloClientConfig {
  /** Apollo API key (per-tenant in production via Vault). */
  apiKey: string
  /**
   * Force mock mode. When omitted, defaults to `process.env.APOLLO_LIVE !== 'true'`,
   * i.e. mock-by-default. Set APOLLO_LIVE=true in `.env.local` to exercise the
   * real client. Sprint 5a ships only the mock path — real Apollo lives in
   * Sprint 7 once the Pro plan is provisioned.
   */
  mockMode?: boolean
}

function isMockByDefault(): boolean {
  return process.env.APOLLO_LIVE !== 'true'
}

/**
 * Apollo client wrapping search + email enrichment. Mock-default so test runs
 * and CI never consume Free-tier credits. Pass `{ mockMode: false }` (or set
 * APOLLO_LIVE=true) to exercise the real path.
 *
 * Sprint 5a scope: searchPeople + findEmail. Sprint 6 (Profiler) will add
 * profile enrichment endpoints. Sprint 7 swaps the live stub for the real
 * Apollo HTTP client once the Pro plan unlocks bulk search.
 */
export class ApolloClient {
  private readonly apiKey: string
  private readonly mockMode: boolean

  constructor(config: ApolloClientConfig) {
    this.apiKey = config.apiKey
    this.mockMode = config.mockMode ?? isMockByDefault()

    if (this.mockMode) {
      // Visible at every instantiation so dev/test never silently exercise mocks
      // thinking they're hitting Apollo. Quiet during tests via NODE_ENV=test.
      if (process.env.NODE_ENV !== 'test') {
        console.log('[apollo] MOCK MODE ACTIVE — set APOLLO_LIVE=true to use real Apollo')
      }
    }
  }

  /**
   * Search Apollo for decision makers matching the filter. In mock mode, runs
   * the filter against `MOCK_CANDIDATES` in-process; in live mode (Sprint 7+)
   * will call the Apollo `/v1/mixed_people/search` endpoint.
   */
  async searchPeople(filters: ApolloSearchFilters): Promise<ApolloSearchResult> {
    if (this.mockMode) {
      return this.searchPeopleMock(filters)
    }
    return this.searchPeopleLive(filters)
  }

  /**
   * Resolve a person's email + confidence by Apollo person ID. Sprint 5a uses
   * mock data; Sprint 7 wires this to Apollo `/v1/people/match` (which is the
   * credit-expensive call we want to gate).
   */
  async findEmail(personId: string): Promise<ApolloEmailResult> {
    if (this.mockMode) {
      return this.findEmailMock(personId)
    }
    return this.findEmailLive(personId)
  }

  // ─── Mock implementations ────────────────────────────────────────────

  private async searchPeopleMock(filters: ApolloSearchFilters): Promise<ApolloSearchResult> {
    const matched = filterMockCandidates(filters)
    const limit = filters.limit ?? 100
    const candidates = matched.slice(0, limit)
    return {
      candidates,
      totalFound: matched.length,
      // Mock: 1 credit per candidate returned, mirroring Apollo's per-result billing.
      creditsConsumed: candidates.length,
    }
  }

  private async findEmailMock(personId: string): Promise<ApolloEmailResult> {
    const person: ApolloPerson | undefined = MOCK_CANDIDATES.find((p) => p.id === personId)
    if (!person) {
      return { email: null, confidence: 0, creditsConsumed: 0 }
    }
    if (person.email) {
      return { email: person.email, confidence: 0.92, creditsConsumed: 1 }
    }
    // Person exists but email was suppressed in fixture — simulate Apollo
    // returning a low-confidence guess (50%) or a hard miss (50%).
    const hash = personId.charCodeAt(personId.length - 1) % 2
    if (hash === 0) {
      const synthesized = `${person.first_name.toLowerCase()}.${person.last_name.toLowerCase()}@${person.company_domain ?? 'example.com'}`
      return { email: synthesized, confidence: 0.55, creditsConsumed: 1 }
    }
    return { email: null, confidence: 0, creditsConsumed: 1 }
  }

  // ─── Live implementations (stubs for Sprint 5a) ─────────────────────

  private async searchPeopleLive(_filters: ApolloSearchFilters): Promise<ApolloSearchResult> {
    // Sprint 7: wire to https://api.apollo.io/v1/mixed_people/search
    // using this.apiKey in the `x-api-key` header. For now we hard-fail loud
    // so anyone toggling APOLLO_LIVE=true knows the live path isn't built.
    throw new Error(
      '[apollo] live mode not implemented in Sprint 5a — wire real client in Sprint 7 (Pro plan upgrade required first)',
    )
  }

  private async findEmailLive(_personId: string): Promise<ApolloEmailResult> {
    // Sprint 7: wire to https://api.apollo.io/v1/people/match
    throw new Error(
      '[apollo] live mode not implemented in Sprint 5a — wire real client in Sprint 7 (Pro plan upgrade required first)',
    )
  }
}
