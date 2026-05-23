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
  normalizeLinkedinUrl,
  synthesizeEmptyPosts,
  synthesizeUnknownProfile,
} from './mock'
