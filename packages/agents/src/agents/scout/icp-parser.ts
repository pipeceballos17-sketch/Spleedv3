import type { icps } from '@spleed/db'
import type { ApolloSearchFilters } from '@spleed/integrations/apollo'

/**
 * The "parsed" portion of an ICP row — i.e. icp.parsedFilters fields the
 * Scout pipeline reads to build Apollo filters and score candidates.
 *
 * Sprint 5a expects this to be set manually in seeds / fixtures. Sprint 6's
 * LLM ICP parser will populate `parsedFilters` from `definitionNaturalLanguage`.
 *
 * `seniorities` is a TS-level addition to icp.parsedFilters (jsonb shape
 * evolves freely; see packages/db/src/schema/leads.ts).
 */
export type IcpRow = typeof icps.$inferSelect

/**
 * Map a stored ICP to the Apollo search filter shape. Pure function — no DB
 * calls, no LLM calls, no I/O. Sprint 5a does a direct field-by-field map;
 * Sprint 6 layers in heuristic refinements (e.g. expanding "founder" titles
 * into [Founder, Co-Founder, Founding Engineer]).
 *
 * Fields left undefined when the ICP doesn't constrain them — Apollo treats
 * an absent filter as "any", which is what we want.
 */
export function parseICPToApolloFilters(icp: IcpRow): ApolloSearchFilters {
  const pf = icp.parsedFilters

  const filters: ApolloSearchFilters = {}

  if (pf.industries && pf.industries.length > 0) {
    filters.industries = pf.industries
  }
  if (pf.companySizeMin !== undefined || pf.companySizeMax !== undefined) {
    filters.companySize = {
      min: pf.companySizeMin,
      max: pf.companySizeMax,
    }
  }
  if (pf.geos && pf.geos.length > 0) {
    filters.locations = pf.geos
  }
  if (pf.titles && pf.titles.length > 0) {
    filters.titles = pf.titles
  }
  if (pf.seniorities && pf.seniorities.length > 0) {
    filters.seniorities = pf.seniorities
  }
  if (pf.techStack && pf.techStack.length > 0) {
    filters.technologies = pf.techStack
  }

  return filters
}
