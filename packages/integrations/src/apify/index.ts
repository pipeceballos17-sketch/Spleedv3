export { ApifyClient, type ApifyClientConfig } from './client'
export type {
  ApifyLinkedinPostsScrapeOptions,
  ApifyLinkedinPostsScrapeResult,
  ApifyLinkedinProfileScrapeResult,
  LinkedinEducation,
  LinkedinPosition,
  LinkedinPost,
  LinkedinProfile,
} from './types'
export {
  MOCK_POSTS,
  MOCK_PROFILES,
  COST_PER_POSTS_USD,
  COST_PER_PROFILE_USD,
  mockScrapeLinkedinPosts,
  mockScrapeLinkedinProfile,
  synthesizeEmptyPosts,
  synthesizeUnknownProfile,
} from './mock'
// Sprint 7a — normalizeLinkedinUrl moved to @spleed/shared/normalize for
// cross-package reuse (API ingest + apify mock + future Composer). Callers
// previously importing from `@spleed/integrations/apify` should switch to
// `@spleed/shared/normalize`.
