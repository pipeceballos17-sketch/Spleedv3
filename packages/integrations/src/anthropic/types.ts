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
// Sprint 7b — 'deep_research' added so final-synthesis (Phase 8) hooks can
// attribute to the deep research source. Initial synthesis (Phase 6) only
// emits the first three; the extra member is additive and unused there.
export type ProfilerSourceName = 'company_website' | 'linkedin' | 'news' | 'deep_research'

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

// ─── Deep research (Sprint 7b — Phase 7) ───────────────────────────

/** One finding within a deep-research signal category. */
export interface DeepResearchFinding {
  signal: string
  evidence: string
  /** Cited source URL where the agent found the signal (optional). */
  source_url?: string
  confidence: number
}

/** One of the universal core-4 categories the deep research targets. */
export interface DeepResearchSignalCategory {
  findings: DeepResearchFinding[]
  summary: string
}

/**
 * Per-tool invocation accounting. The worker turns these counts into
 * granular cost_events rows (one per tool kind). customToolCalls captures
 * Spleed-managed scrapers (Apify/Vercel) invoked mid-research.
 */
export interface DeepResearchToolCalls {
  webSearchCount: number
  webFetchCount: number
  customToolCalls: Array<{ name: string; provider: string; costUsd: number }>
}

/**
 * Output of a deep research session. Four signal categories + integrated
 * hook recommendations, plus cost/latency metadata the worker persists to
 * cost_events. hooks carry sourceName='deep_research' so the final synthesis
 * (Phase 8) can weight them for specificity.
 */
export interface DeepResearchOutput {
  succession_signals: DeepResearchSignalCategory
  hiring_signals: DeepResearchSignalCategory
  tech_stack_signals: DeepResearchSignalCategory
  recent_activity_signals: DeepResearchSignalCategory
  recommended_hooks: Array<{
    hook: string
    evidence: string
    sourceName: 'deep_research'
    confidence: number
  }>
  tokensIn: number
  tokensOut: number
  /** Opus 4.7 LLM cost for the research call (excludes per-tool costs). */
  llmCostUsd: number
  toolCalls: DeepResearchToolCalls
  latencyMs: number
}

export interface ResearchDeepInput {
  systemPrompt: string
  userPrompt: string
  /**
   * Mock lookup hint — pass `lead.companyDomain`. Curated deep-research
   * dossiers (MOCK_DEEP_RESEARCH_DOSSIERS) are keyed on domain.
   */
  domainHint?: string
}

// ─── Final synthesis (Sprint 7b — Phase 8) ─────────────────────────

export interface SynthesizeFinalInput {
  systemPrompt: string
  userPrompt: string
  /** Curated lookup key (combines Phase 6 synthesis + deep research hooks). */
  domainHint?: string
  /** Initial source count (Phase 5). Drives the confidence ceiling. */
  sourcesCount: 1 | 2 | 3
  /**
   * Whether deep research surfaced any findings. When false (Wallace-style
   * empty research), the final confidence stays capped low even with 4
   * nominal sources — deep research that found nothing adds no lift.
   */
  deepResearchHasFindings: boolean
  /** Phase 6 confidence — the floor the final synthesis builds on. */
  initialConfidence: number
}

export interface SynthesizeFinalResult {
  dossier: SynthesizedDossierJson
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

// ─── Concierge parser (Sprint 7c — Slack DM NLP) ───────────────────

/**
 * Subset of POST /api/leads/ingest payload the concierge parser can
 * populate from a free-text Slack DM. icpId never comes from parsing
 * (assigned by the ingest endpoint via org default). Fields are nullable
 * because Haiku may surface only some of them depending on what the
 * founder typed.
 */
export interface ConciergePayload {
  linkedinUrl: string | null
  companyDomain: string | null
  name: string | null
  title: string | null
  notes: string | null
}

export interface ParseConciergeQueryInput {
  systemPrompt: string
  userPrompt: string
  /**
   * Raw founder text — exposed to the mock for pattern matching. Live
   * mode reads the same content from the userPrompt; the field is a
   * lookup hint for deterministic test outputs.
   */
  textHint?: string
}

export interface ParseConciergeQueryResult {
  payload: ConciergePayload
  parseSucceeded: boolean
  errorReason: string | null
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

// ─── Composer (Sprint 8) — 4-step draft pipeline + ICP starter ──────
//
// Leaf I/O contracts for the four Composer LLM calls + the Hermes ICP
// starter generator. The agent layer (packages/agents/.../composer)
// builds the prompts and orchestrates the steps; these types name what
// each AnthropicClient method consumes/returns. Composer runs on the
// client's default model (claude-sonnet-4-6 — quality-critical per
// CLAUDE.md); cost derives from the standard per-model rates.

export type ComposerChannel = 'email' | 'imessage'

/**
 * A hook candidate fed into selection — union of the synthesized dossier
 * hooks (Phase 6/8) and the deep-research recommended hooks (Phase 7).
 * sourceName carries the provenance so selection can weight deep_research.
 */
export interface ComposerHookCandidate {
  hook: string
  evidence: string
  sourceName: ProfilerSourceName
  confidence: number
}

// Step 1 — hook selection
export interface SelectHookInput {
  systemPrompt: string
  userPrompt: string
  /** Mock lookup hint — pass `lead.companyDomain`. */
  domainHint?: string
}
export interface SelectedHook {
  hook: string
  reasoning: string
  confidence: number
}
export interface SelectHookResult {
  /** Top 1-2 hooks the draft will lead with. */
  selectedHooks: SelectedHook[]
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

// Step 2 — angle generation
export interface GenerateAngleInput {
  systemPrompt: string
  userPrompt: string
  domainHint?: string
}
export interface OutreachAngle {
  opener: string
  valueProposition: string
  cta: string
}
export interface GenerateAngleResult {
  angle: OutreachAngle
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

// Step 3 — draft composition (channel-shaped)
export interface ComposeDraftInput {
  systemPrompt: string
  userPrompt: string
  /** Drives length + whether a subject is produced. */
  channel: ComposerChannel
  domainHint?: string
}
export interface ComposedDraft {
  /** NULL for iMessage (body-only). */
  subject: string | null
  body: string
}
export interface ComposeDraftResult {
  draft: ComposedDraft
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

// Step 4 — quality / compliance check
export interface CheckQualityInput {
  systemPrompt: string
  userPrompt: string
  channel: ComposerChannel
  domainHint?: string
}
export interface QualityVerdict {
  passed: boolean
  /** Human-readable problems (empty when passed). */
  issues: string[]
  /** Compliance markers detected (e.g. 'unsubscribe', 'sender_identification'). */
  markersFound: string[]
}
export interface CheckQualityResult {
  verdict: QualityVerdict
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

// Hermes ICP starter generator (Decision 10)
export interface GenerateIcpStarterGuidanceInput {
  systemPrompt: string
  userPrompt: string
  /** Mock lookup hint — the raw ICP description (keyword-matched). */
  icpDescriptionHint?: string
}
/**
 * A public data source Hermes recommends for an ICP (Sprint 9 CP3). This is a
 * RECOMMENDATION + reasoning only — the actual HTTP/scrape adapters land
 * Sprint 9.5+ (with Juan's validated endpoints). `access` is a hint for the
 * future adapter tier, not a wired capability.
 */
export interface RecommendedSource {
  /** Stable snake_case id, e.g. 'sec_edgar', 'fmcsa_socrata', 'ucc_state'. */
  id: string
  /** Human-readable label, e.g. 'SEC EDGAR filings'. */
  label: string
  /** Adapter-tier hint for Sprint 9.5+ wiring. */
  access: 'http_api' | 'browser_scrape' | 'manual'
  /** 1 sentence: why this source matters for THIS ICP. */
  relevance: string
}

export interface IcpStarterGuidance {
  voiceGuidance: string
  footerTemplate: string
  /** Sprint 9 CP3 — public sources relevant to this ICP (may be empty). */
  recommendedSources: RecommendedSource[]
}
export interface GenerateIcpStarterGuidanceResult {
  guidance: IcpStarterGuidance
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

// ─── BYOK connection test (Sprint 8.2 — Decision 9) ─────────────────

export interface TestConnectionResult {
  ok: boolean
  /** Detected plan tier when the API exposes it; null in mock / unknown. */
  planDetected?: 'Pro' | 'Max' | 'Team' | null
  /** Set when ok=false. */
  error?: 'INVALID_KEY' | 'CONNECTION_FAILED'
}

// ─── Composer Phase 0 — channel recommendation (Sprint 8.2) ─────────

export interface ComposerContactData {
  email?: string | null
  phone?: string | null
  linkedinUrl?: string | null
}

/** 'manual_lookup_required' short-circuits the Composer (no draft created). */
export type RecommendedChannel = 'email' | 'imessage' | 'manual_lookup_required'

export interface RecommendChannelInput {
  systemPrompt: string
  userPrompt: string
  /** ICP default channel — the baseline the recommender may override. */
  preferredChannel: ComposerChannel
  contactData: ComposerContactData
  domainHint?: string
}

export interface ChannelRecommendation {
  channel: RecommendedChannel
  reasoning: string
  confidence: number
}

export interface RecommendChannelResult {
  recommendation: ChannelRecommendation
  /** Echo of the contact data the recommendation considered (for the card). */
  contactData: ComposerContactData
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}
