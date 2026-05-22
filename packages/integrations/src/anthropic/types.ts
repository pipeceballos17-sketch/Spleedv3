/**
 * Anthropic re-ranking types for Scout (Sprint 5b Phase 3).
 *
 * Mirrors the subset of the Anthropic SDK we exercise in Sprint 5b's mock
 * path. Sprint 7 swaps to live calls via `@anthropic-ai/sdk` (already in
 * @spleed/agents lockfile from Sprint 3 prompt-cache work).
 *
 * `IcpShape` is intentionally a leaf-package contract — we re-declare the
 * fields the client reads instead of importing IcpRow from @spleed/db. Keeps
 * @spleed/integrations as a no-upstream-dep package; the agents layer adapts
 * (TypeScript structural typing handles the rest at the call site).
 */

import type { ApolloPerson } from '../apollo/types'

export type ScoutLlmModel =
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5'
  | 'claude-opus-4-7'

/**
 * Subset of ICP fields the LLM re-rank prompt consumes. Real IcpRow has more
 * (timestamps, isActive, etc) but the prompt only needs identity + filters.
 */
export interface IcpShape {
  name: string
  definitionNaturalLanguage: string
  parsedFilters: {
    industries?: string[]
    companySizeMin?: number
    companySizeMax?: number
    geos?: string[]
    titles?: string[]
    seniorities?: string[]
    techStack?: string[]
  }
}

export interface ScoreLeadInput {
  icp: IcpShape
  candidate: ApolloPerson
  /** SQL baseline 0-100, passed in so the LLM can use it as an anchor. */
  sqlScore: number
}

export interface ScoreLeadResult {
  /** Pure LLM assessment 0-100. */
  llmScore: number
  /** 1-2 sentence justification, surfaced to founder in dashboard. */
  reasoning: string
  /** Weighted average: 0.4 * sqlScore + 0.6 * llmScore, clamped 0-100. */
  combinedScore: number
  /** Anthropic billing inputs (set even in mock mode for cost_events parity). */
  tokensIn: number
  tokensOut: number
  /** USD computed from per-model pricing (see MODEL_COSTS in client.ts). */
  costUsd: number
  latencyMs: number
}
