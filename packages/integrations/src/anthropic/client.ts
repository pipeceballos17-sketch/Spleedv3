import { mockScoreLead, mockLatencyMs, MOCK_TOKENS_IN, MOCK_TOKENS_OUT } from './mock'
import type { ScoreLeadInput, ScoreLeadResult, ScoutLlmModel } from './types'

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
}

export { SQL_WEIGHT, LLM_WEIGHT, MODEL_COSTS_PER_M_TOKENS }
