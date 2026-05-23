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

// ─── Profiler (Sprint 6a) — company-website extraction ─────────────────

/**
 * Investment/growth stage signals inferable from a company's web presence.
 * `unknown` is the safe default when content carries no stage marker —
 * Profiler should fall back to neutral routing rather than guess.
 */
export type CompanyStage =
  | 'pre-seed'
  | 'seed'
  | 'series-a'
  | 'series-b'
  | 'growth'
  | 'enterprise'
  | 'unknown'

/**
 * Raw signal JSON the LLM returns — hook_candidates here LACK the hookId.
 * The agent layer (packages/agents/.../profiler/company-website-extraction.ts)
 * generates uuids for each hook before persisting to lead_dossiers.evidence_urls.
 */
export interface ExtractedCompanyWebsiteSignals {
  company_stage: CompanyStage
  recent_news: string[]
  pain_signals: string[]
  hiring_signals: string[]
  growth_signals: string[]
  hook_candidates: Array<{
    hook: string
    evidence: string
    confidence: number
  }>
}

export interface ExtractCompanyWebsiteSignalsInput {
  /**
   * System prompt — pre-built by the agent caller. Caller imports
   * PROFILER_SYSTEM_PROMPT from @spleed/db/seed/prompts so the seeded
   * agent_templates row and the runtime call stay in lockstep.
   */
  systemPrompt: string
  /**
   * User prompt with lead/icp/pageContent rendered. Caller builds via
   * buildCompanyWebsiteUserPrompt (agents profiler/prompts.ts).
   */
  userPrompt: string
  /**
   * Optional deterministic-mock key. Pass `lead.company_domain` (preferred)
   * or `lead.company`. Mock client looks up curated signals against this
   * key; unknown keys yield empty-but-valid signals (graceful degradation).
   */
  domainHint?: string
}

export interface ExtractCompanyWebsiteSignalsResult {
  signals: ExtractedCompanyWebsiteSignals
  /** Mock returns fixed estimates; live (Sprint 7+) reads usage from SDK. */
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

// ─── Profiler (Sprint 6b) — LinkedIn + News + Synthesis ────────────

/**
 * LinkedIn and News extraction return the SAME JSON shape as company-
 * website extraction (signals contract is source-agnostic by design;
 * only the prompt and the input differ). Type aliases below name the
 * shape for clarity at call sites without duplicating fields.
 *
 * Sprint 7+: source-specific signal types may diverge (e.g. LinkedIn
 * adds connection-graph signals, news adds funding-round structured
 * fields). For Sprint 6b we keep them aligned so the agent layer
 * (linkedin-extraction.ts, news-extraction.ts) can share its mapping
 * logic with Sprint 6a's company-website-extraction.
 */
export type ExtractedLinkedinSignals = ExtractedCompanyWebsiteSignals
export type ExtractedNewsSignals = ExtractedCompanyWebsiteSignals

export interface ExtractLinkedinSignalsInput {
  systemPrompt: string
  userPrompt: string
  /** Mock lookup hint — pass `lead.linkedinUrl`. */
  linkedinUrlHint?: string
}

export interface ExtractLinkedinSignalsResult {
  signals: ExtractedLinkedinSignals
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

export interface ExtractNewsSignalsInput {
  systemPrompt: string
  userPrompt: string
  /** Mock lookup hint — pass `lead.companyDomain` or company brand. */
  domainHint?: string
}

export interface ExtractNewsSignalsResult {
  signals: ExtractedNewsSignals
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

/**
 * Synthesis output shape — hook_candidates here carry an explicit
 * sourceName (the dedup winner across same-fact mentions). Other
 * dossier-level metadata (recommended_angle, pain_inferred, confidence)
 * is set in this call.
 */
export type ProfilerSourceName = 'company_website' | 'linkedin' | 'news'

export interface SynthesizedHookCandidate {
  hook: string
  /** May concatenate quotes from multiple sources with " | " for dedup'd hooks. */
  evidence: string
  /** The dedup-winning source (news > linkedin > company_website per prompt). */
  sourceName: ProfilerSourceName
  confidence: number
}

export interface SynthesizedDossierJson {
  hook_candidates: SynthesizedHookCandidate[]
  recommended_angle: string
  pain_inferred: string
  confidence_score: number
}

export interface SynthesizeDossierInput {
  systemPrompt: string
  userPrompt: string
  /**
   * Mock lookup hint — pass `lead.companyDomain`. Curated synthesis
   * dossiers are keyed on domain.
   */
  domainHint?: string
  /**
   * Number of source extractions provided. Mock adjusts confidence
   * score down for partial enrichment (max 0.45 / 0.65 / 0.88 for
   * 1 / 2 / 3 sources). Provided by caller so the mock doesn't need
   * to parse the user prompt.
   */
  sourcesCount: 1 | 2 | 3
  /**
   * Available source names (caller-supplied). Mock filters curated
   * hook_candidates to those whose sourceName is in this set so
   * partial enrichment dossiers don't surface hooks whose primary
   * source wasn't actually included.
   */
  availableSources: ProfilerSourceName[]
}

export interface SynthesizeDossierResult {
  dossier: SynthesizedDossierJson
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}
