import {
  mockExtractCompanyWebsiteSignals,
  mockExtractLinkedinSignals,
  mockExtractNewsSignals,
  mockLatencyMs,
  mockLinkedinLatencyMs,
  mockNewsLatencyMs,
  mockProfilerLatencyMs,
  mockResearchDeep,
  mockScoreLead,
  mockSynthesisFinalLatencyMs,
  mockSynthesisLatencyMs,
  mockSynthesizeDossier,
  mockSynthesizeFinal,
  MOCK_SYNTHESIS_FINAL_TOKENS_IN,
  MOCK_SYNTHESIS_FINAL_TOKENS_OUT,
  MOCK_LINKEDIN_TOKENS_IN,
  MOCK_LINKEDIN_TOKENS_OUT,
  MOCK_NEWS_TOKENS_IN,
  MOCK_NEWS_TOKENS_OUT,
  MOCK_PROFILER_TOKENS_IN,
  MOCK_PROFILER_TOKENS_OUT,
  MOCK_SYNTHESIS_TOKENS_IN,
  MOCK_SYNTHESIS_TOKENS_OUT,
  MOCK_TOKENS_IN,
  MOCK_TOKENS_OUT,
} from './mock'
import type {
  ExtractCompanyWebsiteSignalsInput,
  ExtractCompanyWebsiteSignalsResult,
  ExtractLinkedinSignalsInput,
  ExtractLinkedinSignalsResult,
  ExtractNewsSignalsInput,
  ExtractNewsSignalsResult,
  DeepResearchOutput,
  ResearchDeepInput,
  ScoreLeadInput,
  ScoreLeadResult,
  ScoutLlmModel,
  SynthesizeDossierInput,
  SynthesizeDossierResult,
  SynthesizeFinalInput,
  SynthesizeFinalResult,
} from './types'

export interface AnthropicClientConfig {
  /** Anthropic API key. Sprint 7 resolves per-tenant via Vault (BACKLOG-027 BYOK). */
  apiKey: string
  /** Default: env `SCOUT_LLM_MODEL` or `claude-sonnet-4-6`. */
  model?: ScoutLlmModel
  /**
   * Force mock mode. When omitted, defaults to `process.env.ANTHROPIC_LIVE !== 'true'`,
   * i.e. mock-by-default. Set ANTHROPIC_LIVE=true in `.env.local` to exercise
   * the real client (Sprint 7 wires it; today the live path throws loud).
   */
  mockMode?: boolean
}

/**
 * Anthropic billing rates (USD per 1M tokens, 2026 prices). Sonnet 4.6 is the
 * Scout default because re-ranking justifies its accuracy; haiku for cost-
 * sensitive tenants (Sprint 9 toggle: BACKLOG-036); opus for premium tier.
 */
const MODEL_COSTS_PER_M_TOKENS: Record<ScoutLlmModel, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-4-7': { input: 15, output: 75 },
}

/** Weighted average: SQL phase contributes 40%, LLM phase 60%. Per ADR 0002. */
const SQL_WEIGHT = 0.4
const LLM_WEIGHT = 0.6

function isMockByDefault(): boolean {
  return process.env.ANTHROPIC_LIVE !== 'true'
}

function defaultModel(): ScoutLlmModel {
  const env = process.env.SCOUT_LLM_MODEL
  if (env === 'claude-sonnet-4-6' || env === 'claude-haiku-4-5' || env === 'claude-opus-4-7') {
    return env
  }
  return 'claude-sonnet-4-6'
}

function computeCostUsd(model: ScoutLlmModel, tokensIn: number, tokensOut: number): number {
  const rates = MODEL_COSTS_PER_M_TOKENS[model]
  const inputCost = (tokensIn / 1_000_000) * rates.input
  const outputCost = (tokensOut / 1_000_000) * rates.output
  return inputCost + outputCost
}

/**
 * Anthropic client for Scout's LLM re-ranking phase (ADR 0002 Phase 3). Mock-
 * default so test runs and CI never burn Anthropic credits; pass
 * `{ mockMode: false }` or set ANTHROPIC_LIVE=true to exercise the real
 * client path (currently throws loud — Sprint 7 wires the @anthropic-ai/sdk
 * call once per-tenant BYOK keys land).
 *
 * Sprint 5b ships scoreLead only. Profiler (Sprint 6) and Composer (Sprint 7)
 * will add their own methods to this client.
 */
export class AnthropicClient {
  readonly model: ScoutLlmModel
  private readonly apiKey: string
  private readonly mockMode: boolean

  constructor(config: AnthropicClientConfig) {
    this.apiKey = config.apiKey
    this.model = config.model ?? defaultModel()
    this.mockMode = config.mockMode ?? isMockByDefault()

    if (this.mockMode && process.env.NODE_ENV !== 'test') {
      console.log(
        '[anthropic] MOCK MODE ACTIVE — set ANTHROPIC_LIVE=true to use real Anthropic',
      )
    }
  }

  /**
   * Score a single (candidate, ICP) pair. Worker fans out via `Promise.all`
   * to score up to 100 candidates concurrently (Decision A, paralelo).
   */
  async scoreLead(input: ScoreLeadInput): Promise<ScoreLeadResult> {
    if (this.mockMode) {
      return this.scoreLeadMock(input)
    }
    return this.scoreLeadLive(input)
  }

  // ─── Mock implementation ─────────────────────────────────────────────

  private async scoreLeadMock(input: ScoreLeadInput): Promise<ScoreLeadResult> {
    const { llmScore, reasoning } = mockScoreLead(input)
    const tokensIn = MOCK_TOKENS_IN
    const tokensOut = MOCK_TOKENS_OUT
    const latencyMs = mockLatencyMs(input.candidate.id)
    const costUsd = computeCostUsd(this.model, tokensIn, tokensOut)

    const combinedScore = Math.min(
      100,
      Math.round(SQL_WEIGHT * input.sqlScore + LLM_WEIGHT * llmScore),
    )

    return { llmScore, reasoning, combinedScore, tokensIn, tokensOut, costUsd, latencyMs }
  }

  // ─── Live implementation (stub for Sprint 5b) ───────────────────────

  private async scoreLeadLive(_input: ScoreLeadInput): Promise<ScoreLeadResult> {
    // Sprint 7: wire to @anthropic-ai/sdk Messages.create using this.apiKey
    // (BYOK per-tenant from Vault — BACKLOG-027). Build prompts from
    // buildRerankPrompt(input) and parseRerankResponse(response).
    throw new Error(
      '[anthropic] live mode not implemented in Sprint 5b — wire real client in Sprint 7 with BYOK (BACKLOG-027)',
    )
  }

  // ─── Profiler (Sprint 6a) — company-website extraction ─────────────

  /**
   * Extract structured signals (stage, news, pains, hiring, growth, hooks)
   * from a single source — Sprint 6a wires this to the company website
   * source only. Sprint 6b adds LinkedIn + news source calls (3 extractions
   * + 1 synthesis structured pipeline per Sprint 6 Decision 3).
   *
   * Caller (agents profiler/company-website-extraction.ts) is responsible
   * for building both system and user prompts and for layering hookId
   * uuids onto hook_candidates before persisting to lead_dossiers.
   */
  async extractCompanyWebsiteSignals(
    input: ExtractCompanyWebsiteSignalsInput,
  ): Promise<ExtractCompanyWebsiteSignalsResult> {
    if (this.mockMode) {
      return this.extractCompanyWebsiteSignalsMock(input)
    }
    return this.extractCompanyWebsiteSignalsLive(input)
  }

  private async extractCompanyWebsiteSignalsMock(
    input: ExtractCompanyWebsiteSignalsInput,
  ): Promise<ExtractCompanyWebsiteSignalsResult> {
    const signals = mockExtractCompanyWebsiteSignals({ domainHint: input.domainHint })
    const tokensIn = MOCK_PROFILER_TOKENS_IN
    const tokensOut = MOCK_PROFILER_TOKENS_OUT
    // Latency hint: prefer domainHint, fall back to prompt length so unknown
    // domains still produce stable per-input latency in tests.
    const latencyHint = input.domainHint ?? `len-${input.userPrompt.length}`
    const latencyMs = mockProfilerLatencyMs(latencyHint)
    const costUsd = computeCostUsd(this.model, tokensIn, tokensOut)
    return { signals, tokensIn, tokensOut, costUsd, latencyMs }
  }

  private async extractCompanyWebsiteSignalsLive(
    _input: ExtractCompanyWebsiteSignalsInput,
  ): Promise<ExtractCompanyWebsiteSignalsResult> {
    // Sprint 7+: wire to @anthropic-ai/sdk Messages.create with system prompt
    // marked `cache_control: ephemeral` (PROFILER_SYSTEM_PROMPT is stable
    // across a profiling batch so prompt-cache amortization is meaningful).
    // Use this.apiKey from Vault (BYOK per-tenant — BACKLOG-027). Robust JSON
    // parse: pull first balanced object out of response.content[0].text,
    // fall back to EMPTY_SIGNALS on parse failure.
    throw new Error(
      '[anthropic] live mode not implemented in Sprint 6a — wire real client in Sprint 7+ with BYOK (BACKLOG-027)',
    )
  }

  // ─── Profiler (Sprint 6b) — LinkedIn + News + Synthesis ──────────

  /**
   * Extract structured signals from a LinkedIn profile + recent posts.
   * Caller (agents linkedin-extraction.ts) builds both prompts and
   * passes linkedinUrlHint so the mock can look up curated signals
   * deterministically.
   */
  async extractLinkedinSignals(
    input: ExtractLinkedinSignalsInput,
  ): Promise<ExtractLinkedinSignalsResult> {
    if (this.mockMode) {
      return this.extractLinkedinSignalsMock(input)
    }
    return this.extractLinkedinSignalsLive(input)
  }

  /**
   * Extract structured signals from a set of news articles. Caller
   * (agents news-extraction.ts) builds prompts and passes domainHint.
   */
  async extractNewsSignals(
    input: ExtractNewsSignalsInput,
  ): Promise<ExtractNewsSignalsResult> {
    if (this.mockMode) {
      return this.extractNewsSignalsMock(input)
    }
    return this.extractNewsSignalsLive(input)
  }

  /**
   * Consolidate 1-3 source extractions into the final ranked dossier.
   * sourcesCount + availableSources let the mock adjust output for
   * partial-enrichment scenarios; live mode (Sprint 7+) reads the same
   * info from the user prompt itself.
   */
  async synthesizeDossier(
    input: SynthesizeDossierInput,
  ): Promise<SynthesizeDossierResult> {
    if (this.mockMode) {
      return this.synthesizeDossierMock(input)
    }
    return this.synthesizeDossierLive(input)
  }

  // ─── Mock implementations (Sprint 6b) ─────────────────────────────

  private async extractLinkedinSignalsMock(
    input: ExtractLinkedinSignalsInput,
  ): Promise<ExtractLinkedinSignalsResult> {
    const signals = mockExtractLinkedinSignals({
      linkedinUrlHint: input.linkedinUrlHint,
    })
    const tokensIn = MOCK_LINKEDIN_TOKENS_IN
    const tokensOut = MOCK_LINKEDIN_TOKENS_OUT
    const latencyHint = input.linkedinUrlHint ?? `len-${input.userPrompt.length}`
    const latencyMs = mockLinkedinLatencyMs(latencyHint)
    const costUsd = computeCostUsd(this.model, tokensIn, tokensOut)
    return { signals, tokensIn, tokensOut, costUsd, latencyMs }
  }

  private async extractNewsSignalsMock(
    input: ExtractNewsSignalsInput,
  ): Promise<ExtractNewsSignalsResult> {
    const signals = mockExtractNewsSignals({ domainHint: input.domainHint })
    const tokensIn = MOCK_NEWS_TOKENS_IN
    const tokensOut = MOCK_NEWS_TOKENS_OUT
    const latencyHint = input.domainHint ?? `len-${input.userPrompt.length}`
    const latencyMs = mockNewsLatencyMs(latencyHint)
    const costUsd = computeCostUsd(this.model, tokensIn, tokensOut)
    return { signals, tokensIn, tokensOut, costUsd, latencyMs }
  }

  private async synthesizeDossierMock(
    input: SynthesizeDossierInput,
  ): Promise<SynthesizeDossierResult> {
    const dossier = mockSynthesizeDossier({
      domainHint: input.domainHint,
      sourcesCount: input.sourcesCount,
      availableSources: input.availableSources,
    })
    const tokensIn = MOCK_SYNTHESIS_TOKENS_IN
    const tokensOut = MOCK_SYNTHESIS_TOKENS_OUT
    const latencyHint = input.domainHint ?? `synth-len-${input.userPrompt.length}`
    const latencyMs = mockSynthesisLatencyMs(latencyHint)
    const costUsd = computeCostUsd(this.model, tokensIn, tokensOut)
    return { dossier, tokensIn, tokensOut, costUsd, latencyMs }
  }

  // ─── Live stubs (Sprint 6b — defer to Sprint 7+) ───────────────────

  private async extractLinkedinSignalsLive(
    _input: ExtractLinkedinSignalsInput,
  ): Promise<ExtractLinkedinSignalsResult> {
    throw new Error(
      '[anthropic] live mode not implemented in Sprint 6b — wire real client in Sprint 7+ with BYOK (BACKLOG-027)',
    )
  }

  private async extractNewsSignalsLive(
    _input: ExtractNewsSignalsInput,
  ): Promise<ExtractNewsSignalsResult> {
    throw new Error(
      '[anthropic] live mode not implemented in Sprint 6b — wire real client in Sprint 7+ with BYOK (BACKLOG-027)',
    )
  }

  private async synthesizeDossierLive(
    _input: SynthesizeDossierInput,
  ): Promise<SynthesizeDossierResult> {
    throw new Error(
      '[anthropic] live mode not implemented in Sprint 6b — wire real client in Sprint 7+ with BYOK (BACKLOG-027)',
    )
  }

  // ─── Deep research (Sprint 7b — Phase 7) ─────────────────────────

  /**
   * Run a deep-research session (Opus 4.7 + native web tools + Spleed
   * custom scrapers). Caller (DeepResearchAgent) builds the prompts and
   * passes domainHint for mock lookup. Mock returns curated dossiers
   * (MOCK_DEEP_RESEARCH_DOSSIERS) with Opus-rate cost metadata; live mode
   * (Sprint 8+) wires the real Opus call with tool-use loop.
   *
   * Separate env flag (ANTHROPIC_DEEP_RESEARCH_LIVE) so Felipe can dev-
   * validate the live research loop independently of the cheaper
   * extraction/synthesis live paths (ANTHROPIC_LIVE).
   */
  async researchDeep(input: ResearchDeepInput): Promise<DeepResearchOutput> {
    const liveDeepResearch = process.env.ANTHROPIC_DEEP_RESEARCH_LIVE === 'true'
    if (this.mockMode && !liveDeepResearch) {
      return mockResearchDeep({ domainHint: input.domainHint })
    }
    return this.researchDeepLive(input)
  }

  private async researchDeepLive(_input: ResearchDeepInput): Promise<DeepResearchOutput> {
    // Sprint 8+: wire to @anthropic-ai/sdk Messages.create with model
    // claude-opus-4-7, tools [web_search_20250305, web_fetch_20250712,
    // scrape_linkedin_profile, scrape_company_website], and a tool-use
    // loop that routes custom tools to the Apify/Vercel handlers. Parse
    // the final JSON into DeepResearchOutput; accumulate per-tool costs.
    throw new Error(
      '[anthropic] deep research live mode not implemented in Sprint 7b — wire real Opus 4.7 + tool handling in Sprint 8+ when concierge customers come online',
    )
  }

  // ─── Final synthesis (Sprint 7b — Phase 8) ───────────────────────

  /**
   * Consolidate the 1-3 initial sources + the deep research dossier into
   * the FINAL outreach dossier (PROFILER_SYNTHESIS_FINAL_PROMPT). Higher
   * confidence ceiling than Phase 6 (0.95 with 4 substantive sources).
   * Caller (synthesis-final agent) builds the prompts + supplies the
   * confidence-calibration hints the mock needs.
   */
  async synthesizeFinal(input: SynthesizeFinalInput): Promise<SynthesizeFinalResult> {
    if (this.mockMode) {
      return this.synthesizeFinalMock(input)
    }
    return this.synthesizeFinalLive(input)
  }

  private async synthesizeFinalMock(
    input: SynthesizeFinalInput,
  ): Promise<SynthesizeFinalResult> {
    const dossier = mockSynthesizeFinal({
      domainHint: input.domainHint,
      sourcesCount: input.sourcesCount,
      deepResearchHasFindings: input.deepResearchHasFindings,
      initialConfidence: input.initialConfidence,
    })
    const tokensIn = MOCK_SYNTHESIS_FINAL_TOKENS_IN
    const tokensOut = MOCK_SYNTHESIS_FINAL_TOKENS_OUT
    const latencyHint = input.domainHint ?? `synthfinal-len-${input.userPrompt.length}`
    const latencyMs = mockSynthesisFinalLatencyMs(latencyHint)
    const costUsd = computeCostUsd(this.model, tokensIn, tokensOut)
    return { dossier, tokensIn, tokensOut, costUsd, latencyMs }
  }

  private async synthesizeFinalLive(
    _input: SynthesizeFinalInput,
  ): Promise<SynthesizeFinalResult> {
    throw new Error(
      '[anthropic] final synthesis live mode not implemented in Sprint 7b — wire real client in Sprint 8+ with BYOK (BACKLOG-027)',
    )
  }
}

export { SQL_WEIGHT, LLM_WEIGHT, MODEL_COSTS_PER_M_TOKENS }
