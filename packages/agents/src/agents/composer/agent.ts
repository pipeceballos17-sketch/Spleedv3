/**
 * Composer agent (Sprint 8.1) — 4-step draft pipeline.
 *
 *   1. hook selection   → top 1-2 hooks (deep-research weighted)
 *   2. angle generation → opener + value proposition + CTA
 *   3. draft composition→ channel-shaped subject + body
 *   4. quality check    → compliance/spam gate
 *
 * Each step runs on the tenant's AnthropicClient (Sonnet 4.6 default). The
 * four step implementations are injectable seams (constructor deps) so tests
 * and the Sprint 8.1 demo exercise orchestration without curated drift —
 * mirrors the Sprint 7c concierge worker pattern.
 *
 * compose() returns a discriminated ComposerOutput (composed | failed_quality)
 * rather than throwing, so the Sprint 8.2 worker can branch (post approval
 * card vs offer 🔄 Regenerate) and still record cost for a failed draft.
 */

import {
  buildAngleGenerationPrompt,
  buildChannelRecommendationPrompt,
  buildDraftCompositionPrompt,
  buildHookSelectionPrompt,
  buildIcpStarterGuidancePrompt,
  buildQualityCheckPrompt,
  COMPOSER_ANGLE_GENERATION_PROMPT,
  COMPOSER_CHANNEL_RECOMMENDATION_PROMPT,
  COMPOSER_DRAFT_COMPOSITION_PROMPT,
  COMPOSER_HOOK_SELECTION_PROMPT,
  COMPOSER_QUALITY_CHECK_PROMPT,
  ICP_STARTER_GUIDANCE_PROMPT,
} from './prompts'
import type {
  AngleGenerationResult,
  AngleGenerator,
  ChannelRecommendationResult,
  ChannelRecommender,
  ComposerCostBreakdown,
  ComposerChannel,
  ComposerInput,
  ComposerOutput,
  ComposerStepCost,
  DraftComposer,
  DraftCompositionResult,
  GenerateIcpStarterInput,
  HookSelectionResult,
  HookSelector,
  IcpStarterResult,
  QualityCheckResult,
  QualityChecker,
} from './types'
import type { AnthropicClient } from '@spleed/integrations/anthropic'

export interface ComposerAgentDeps {
  anthropicClient: AnthropicClient
  channelRecommender?: ChannelRecommender
  hookSelector?: HookSelector
  angleGenerator?: AngleGenerator
  draftComposer?: DraftComposer
  qualityChecker?: QualityChecker
}

/**
 * Thrown by compose() when Phase 0 returns 'manual_lookup_required' (no email
 * or phone on file). The worker catches it, skips draft creation, and notifies
 * the founder that a manual contact lookup is needed.
 */
export class ComposerNoContactError extends Error {
  readonly reasoning: string
  constructor(reasoning: string) {
    super(`Composer: manual contact lookup required — ${reasoning}`)
    this.name = 'ComposerNoContactError'
    this.reasoning = reasoning
  }
}

function stepCost(r: ComposerStepCost): ComposerStepCost {
  return { tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd, latencyMs: r.latencyMs }
}

export class ComposerAgent {
  private readonly anthropic: AnthropicClient
  private readonly channelRecommender: ChannelRecommender
  private readonly hookSelector: HookSelector
  private readonly angleGenerator: AngleGenerator
  private readonly draftComposer: DraftComposer
  private readonly qualityChecker: QualityChecker

  constructor(deps: ComposerAgentDeps) {
    this.anthropic = deps.anthropicClient
    this.channelRecommender = deps.channelRecommender ?? this.defaultChannelRecommender.bind(this)
    this.hookSelector = deps.hookSelector ?? this.defaultHookSelector.bind(this)
    this.angleGenerator = deps.angleGenerator ?? this.defaultAngleGenerator.bind(this)
    this.draftComposer = deps.draftComposer ?? this.defaultDraftComposer.bind(this)
    this.qualityChecker = deps.qualityChecker ?? this.defaultQualityChecker.bind(this)
  }

  async compose(input: ComposerInput): Promise<ComposerOutput> {
    // ─── Phase 0: channel recommendation ──────────────────────────────
    const channelRec = await this.channelRecommender({ input })
    if (channelRec.recommendation.channel === 'manual_lookup_required') {
      throw new ComposerNoContactError(channelRec.recommendation.reasoning)
    }
    const channel: ComposerChannel = channelRec.recommendation.channel
    // Steps 1-4 draft for the recommended channel (overrides the ICP default).
    const effInput: ComposerInput = { ...input, icp: { ...input.icp, preferredChannel: channel } }

    // ─── Phase 1-4 run sequentially — each step feeds the next ─────────
    const hook = await this.hookSelector({ input: effInput })
    const angle = await this.angleGenerator({ input: effInput, selectedHooks: hook.selectedHooks })
    const draft = await this.draftComposer({ input: effInput, angle: angle.angle })
    const quality = await this.qualityChecker({ input: effInput, draft: draft.draft })

    const costBreakdown = this.rollCost(channelRec, hook, angle, draft, quality)
    const channelMeta = {
      channel,
      channelReasoning: channelRec.recommendation.reasoning,
      channelConfidence: channelRec.recommendation.confidence,
      contactData: channelRec.contactData,
    }

    if (!quality.verdict.passed) {
      return {
        status: 'failed_quality',
        ...channelMeta,
        subject: draft.draft.subject,
        body: draft.draft.body,
        qualityVerdict: quality.verdict,
        costBreakdown,
      }
    }

    return {
      status: 'composed',
      ...channelMeta,
      subject: draft.draft.subject,
      body: draft.draft.body,
      selectedHooks: hook.selectedHooks,
      angle: angle.angle,
      qualityVerdict: quality.verdict,
      costBreakdown,
    }
  }

  /**
   * Hermes ICP starter (Decision 10) — generate voice + footer guidance from
   * an ICP description. Sprint 8.1 ships the function; Sprint 8.2 wires the
   * dashboard UI that calls it. Manual invocation available via the demo.
   */
  async generateIcpStarterGuidance(input: GenerateIcpStarterInput): Promise<IcpStarterResult> {
    const userPrompt = buildIcpStarterGuidancePrompt({
      icpDescription: input.icpDescription,
      icpIndustry: input.icpIndustry,
    })
    const result = await input.anthropicClient.generateIcpStarterGuidance({
      systemPrompt: ICP_STARTER_GUIDANCE_PROMPT,
      userPrompt,
      // Fold industry into the hint so keyword detection sees it even when the
      // free-text description omits an explicit industry term.
      icpDescriptionHint: [input.icpDescription, input.icpIndustry].filter(Boolean).join(' '),
    })
    return {
      icpId: input.icpId,
      guidance: result.guidance,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
    }
  }

  // ─── Default step implementations (AnthropicClient-backed) ─────────

  private async defaultChannelRecommender(ctx: {
    input: ComposerInput
  }): Promise<ChannelRecommendationResult> {
    const { input } = ctx
    const userPrompt = buildChannelRecommendationPrompt(input)
    const r = await this.anthropic.recommendChannel({
      systemPrompt: COMPOSER_CHANNEL_RECOMMENDATION_PROMPT,
      userPrompt,
      preferredChannel: input.icp.preferredChannel,
      contactData: {
        email: input.lead.email ?? null,
        phone: input.lead.phone ?? null,
        linkedinUrl: input.lead.linkedinUrl ?? null,
      },
      domainHint: input.lead.companyDomain ?? undefined,
    })
    return { recommendation: r.recommendation, contactData: r.contactData, ...stepCost(r) }
  }

  private async defaultHookSelector(ctx: { input: ComposerInput }): Promise<HookSelectionResult> {
    const { input } = ctx
    const userPrompt = buildHookSelectionPrompt(input)
    const r = await this.anthropic.selectHook({
      systemPrompt: COMPOSER_HOOK_SELECTION_PROMPT,
      userPrompt,
      domainHint: input.lead.companyDomain ?? undefined,
    })
    return { selectedHooks: r.selectedHooks, ...stepCost(r) }
  }

  private async defaultAngleGenerator(ctx: {
    input: ComposerInput
    selectedHooks: HookSelectionResult['selectedHooks']
  }): Promise<AngleGenerationResult> {
    const { input, selectedHooks } = ctx
    const userPrompt = buildAngleGenerationPrompt(input, selectedHooks)
    const r = await this.anthropic.generateAngle({
      systemPrompt: COMPOSER_ANGLE_GENERATION_PROMPT,
      userPrompt,
      domainHint: input.lead.companyDomain ?? undefined,
    })
    return { angle: r.angle, ...stepCost(r) }
  }

  private async defaultDraftComposer(ctx: {
    input: ComposerInput
    angle: AngleGenerationResult['angle']
  }): Promise<DraftCompositionResult> {
    const { input, angle } = ctx
    const userPrompt = buildDraftCompositionPrompt(input, angle)
    const r = await this.anthropic.composeDraft({
      systemPrompt: COMPOSER_DRAFT_COMPOSITION_PROMPT,
      userPrompt,
      channel: input.icp.preferredChannel,
      domainHint: input.lead.companyDomain ?? undefined,
    })
    return { draft: r.draft, ...stepCost(r) }
  }

  private async defaultQualityChecker(ctx: {
    input: ComposerInput
    draft: DraftCompositionResult['draft']
  }): Promise<QualityCheckResult> {
    const { input, draft } = ctx
    const channel = input.icp.preferredChannel
    const userPrompt = buildQualityCheckPrompt(input, draft, channel)
    const r = await this.anthropic.checkQuality({
      systemPrompt: COMPOSER_QUALITY_CHECK_PROMPT,
      userPrompt,
      channel,
      domainHint: input.lead.companyDomain ?? undefined,
    })
    return { verdict: r.verdict, ...stepCost(r) }
  }

  private rollCost(
    channelRec: ChannelRecommendationResult,
    hook: HookSelectionResult,
    angle: AngleGenerationResult,
    draft: DraftCompositionResult,
    quality: QualityCheckResult,
  ): ComposerCostBreakdown {
    const steps = [channelRec, hook, angle, draft, quality]
    return {
      channelRecommendation: stepCost(channelRec),
      hookSelection: stepCost(hook),
      angleGeneration: stepCost(angle),
      draftComposition: stepCost(draft),
      qualityCheck: stepCost(quality),
      totalTokensIn: steps.reduce((s, x) => s + x.tokensIn, 0),
      totalTokensOut: steps.reduce((s, x) => s + x.tokensOut, 0),
      totalCostUsd: steps.reduce((s, x) => s + x.costUsd, 0),
      totalLatencyMs: steps.reduce((s, x) => s + x.latencyMs, 0),
    }
  }
}
