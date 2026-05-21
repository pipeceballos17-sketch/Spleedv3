import type { ApolloPerson } from '@spleed/integrations/apollo'
import type { IcpRow } from './icp-parser'

/**
 * Weight allocation per ADR 0002 Phase 2 (SQL phase). Sums to 100; LLM
 * re-ranking in Sprint 5b will multiply this score by a 0-1 confidence and
 * add up to 20 bonus points for behavioral signals (capped at 100).
 *
 * Sprint 5a holds these constant — they become tenant-tunable in Sprint 9+
 * via icp.parsedFilters.weight_overrides.
 */
export const FIT_SCORE_WEIGHTS = {
  industry: 30,
  size: 25,
  technographics: 20,
  location: 15,
  titleSeniority: 10,
} as const

const norm = (s: string): string => s.toLowerCase()

/**
 * Deterministic 0-100 fit score for an Apollo candidate against an ICP.
 * Pure function — no DB, no LLM, no I/O. Same inputs always produce the
 * same output; tests assert exact values.
 *
 * Scoring rules (sum capped at 100):
 *   industry (30)         — exact case-insensitive match on candidate.industry
 *   size (25)             — candidate.company_size within [min, max] inclusive
 *   technographics (20)   — round((intersection / icp.techStack.length) * 20)
 *   location (15)         — any ICP geo is a case-insensitive substring of candidate.location
 *   titleSeniority (10)   — title substring match OR seniority exact match
 *
 * Edge cases (treated uniformly as "no preference → no boost", 0 points):
 *   - ICP industry list empty / undefined
 *   - ICP size range absent
 *   - ICP geo list empty / undefined
 *   - ICP techStack empty / undefined
 *   - ICP titles AND seniorities both empty / undefined
 *   - candidate.industry / company_size / location / technologies / seniority missing
 *
 * The deliberate symmetry (missing on either side = 0) keeps scoring intuitive:
 * a perfectly-matching candidate against a wide-open ICP scores 0, not 100.
 * Founders are expected to fill at least industry + titles to get useful scores.
 */
export function calculateSQLFitScore(candidate: ApolloPerson, icp: IcpRow): number {
  const pf = icp.parsedFilters
  let score = 0

  // industry — 30 points
  if (
    pf.industries &&
    pf.industries.length > 0 &&
    candidate.industry &&
    pf.industries.some((i) => norm(i) === norm(candidate.industry!))
  ) {
    score += FIT_SCORE_WEIGHTS.industry
  }

  // size — 25 points
  const hasSizeConstraint = pf.companySizeMin !== undefined || pf.companySizeMax !== undefined
  if (hasSizeConstraint && candidate.company_size !== undefined) {
    const minOk = pf.companySizeMin === undefined || candidate.company_size >= pf.companySizeMin
    const maxOk = pf.companySizeMax === undefined || candidate.company_size <= pf.companySizeMax
    if (minOk && maxOk) {
      score += FIT_SCORE_WEIGHTS.size
    }
  }

  // technographics — up to 20 points, fractional via intersection ratio
  if (pf.techStack && pf.techStack.length > 0) {
    const candTechs = (candidate.technologies ?? []).map(norm)
    const icpTechs = pf.techStack.map(norm)
    const intersection = icpTechs.filter((t) => candTechs.includes(t)).length
    score += Math.round((intersection / icpTechs.length) * FIT_SCORE_WEIGHTS.technographics)
  }

  // location — 15 points
  if (pf.geos && pf.geos.length > 0 && candidate.location) {
    const loc = norm(candidate.location)
    if (pf.geos.some((g) => loc.includes(norm(g)))) {
      score += FIT_SCORE_WEIGHTS.location
    }
  }

  // title or seniority — 10 points (OR semantics; either match grants full credit)
  let titleSeniorityHit = false
  if (pf.titles && pf.titles.length > 0) {
    const candTitle = norm(candidate.title)
    if (pf.titles.some((t) => candTitle.includes(norm(t)))) {
      titleSeniorityHit = true
    }
  }
  if (!titleSeniorityHit && pf.seniorities && pf.seniorities.length > 0 && candidate.seniority) {
    if (pf.seniorities.some((s) => norm(s) === norm(candidate.seniority!))) {
      titleSeniorityHit = true
    }
  }
  if (titleSeniorityHit) {
    score += FIT_SCORE_WEIGHTS.titleSeniority
  }

  return Math.min(100, score)
}
