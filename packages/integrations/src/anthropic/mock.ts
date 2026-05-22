import type { ScoreLeadInput } from './types'

/**
 * Deterministic LLM mock — pure function of (candidate, icp, sqlScore).
 * Tests rely on stable outputs; we synthesize "noise" by hashing the
 * candidate id rather than calling Math.random(), so the same input always
 * produces the same output.
 *
 * Scoring model (Sprint 5b approximation):
 *   start    = sqlScore
 *   bonus    = +10 if candidate.industry exactly matches any ICP industry,
 *              -5 if ICP specifies industries but candidate doesn't match
 *   noise    = deterministic ±3 derived from candidate.id char-sum mod 7 − 3
 *   llmScore = clamp(start + bonus + noise, 0, 100)
 *
 * Sprint 7 replaces this with real Anthropic calls. The fixture intent is
 * to surface "LLM moved the needle" so dashboard regressions are visible.
 */
export function mockScoreLead(input: ScoreLeadInput): {
  llmScore: number
  reasoning: string
} {
  const { icp, candidate, sqlScore } = input

  const icpIndustries = (icp.parsedFilters.industries ?? []).map((s) => s.toLowerCase())
  let bonus = 0
  let reasoningHint = 'baseline'

  if (icpIndustries.length > 0) {
    if (candidate.industry && icpIndustries.includes(candidate.industry.toLowerCase())) {
      bonus = 10
      reasoningHint = 'industry exact match'
    } else {
      bonus = -5
      reasoningHint = 'industry mismatch vs ICP'
    }
  }

  // Deterministic ±3 from candidate id. Sum char codes mod 7, subtract 3 to
  // center on zero. Same candidate always lands on the same offset.
  const charSum = [...candidate.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  const noise = (charSum % 7) - 3

  const llmScore = Math.min(100, Math.max(0, sqlScore + bonus + noise))
  const reasoning = `Mock: SQL ${sqlScore} → LLM ${llmScore} (${reasoningHint}, noise ${noise >= 0 ? '+' : ''}${noise}).`

  return { llmScore, reasoning }
}

/**
 * Mock token counts — realistic enough for cost_events parity in tests
 * without pretending to match true Anthropic billing. Prompt size in
 * Sprint 5b is ~200 input tokens (ICP + candidate compact format) and ~80
 * output tokens (JSON answer).
 */
export const MOCK_TOKENS_IN = 200
export const MOCK_TOKENS_OUT = 80

/**
 * Mock latency: deterministic 200-800ms band derived from candidate id, so
 * the same candidate yields the same latency on every run.
 */
export function mockLatencyMs(candidateId: string): number {
  const charSum = [...candidateId].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return 200 + (charSum % 600)
}
