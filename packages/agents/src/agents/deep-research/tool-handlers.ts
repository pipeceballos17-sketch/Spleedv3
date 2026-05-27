/**
 * Spleed custom tool handlers for deep research (Sprint 7b foundation,
 * wired live in Sprint 8+).
 *
 * Anthropic native tools (web_search, web_fetch) are handled server-side
 * by the Anthropic API. These two custom tools route to Spleed-managed
 * scrapers so the deep-research agent can pull richer LinkedIn/website
 * data mid-session. In Sprint 7b mock mode they're constructed but not
 * invoked (mockResearchDeep returns curated dossiers); Sprint 8+ live
 * researchDeep loop calls them when the model emits the tool_use blocks.
 */

import type { ApifyClient } from '@spleed/integrations/apify'
import type { VercelBrowserClient } from '@spleed/integrations/vercel-browser'

export interface DeepResearchToolHandlers {
  /** Pull a LinkedIn profile + posts via Apify. Returns JSON-stringifiable result. */
  scrape_linkedin_profile: (linkedinUrl: string) => Promise<unknown>
  /** Pull a company website via Vercel agent-browser. */
  scrape_company_website: (domain: string) => Promise<unknown>
}

/**
 * Build the custom-tool handler map. Each handler wraps a Spleed client
 * call and returns a JSON-serializable result the tool-use loop feeds back
 * to the model as a tool_result block.
 */
export function createToolHandlers(deps: {
  apifyClient: ApifyClient
  vercelBrowserClient: VercelBrowserClient
}): DeepResearchToolHandlers {
  return {
    scrape_linkedin_profile: async (linkedinUrl: string) => {
      const [profile, posts] = await Promise.all([
        deps.apifyClient.scrapeLinkedinProfile(linkedinUrl),
        deps.apifyClient.scrapeLinkedinPosts(linkedinUrl, { limit: 5 }),
      ])
      return { profile: profile.profile, posts: posts.posts }
    },
    scrape_company_website: async (domain: string) => {
      const scrape = await deps.vercelBrowserClient.scrapeCompanyWebsite(domain)
      return scrape.pageContent
    },
  }
}
