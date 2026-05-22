export { VercelBrowserClient, type VercelBrowserClientConfig } from './client'
export type {
  CompanyWebsitePageContent,
  CompanyWebsiteScrapeMetadata,
  CompanyWebsiteScrapeResult,
} from './types'
export {
  MOCK_COMPANY_WEBSITES,
  mockScrapeCompanyWebsite,
  synthesizeUnknownDomain,
  COST_PER_SCRAPE_USD,
  CREDITS_PER_SCRAPE,
} from './mock'
