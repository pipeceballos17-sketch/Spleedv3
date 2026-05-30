/**
 * Composer agent types (Sprint 8.1 — 4-step draft pipeline + ICP starter).
 *
 * The Composer turns an enriched dossier into a single channel-shaped outreach
 * draft via four sequential LLM steps (hook selection → angle → composition →
 * quality check). Leaf-shaped inputs (mirrors profiler LeadShape / IcpShape)
 * keep tests free of full Drizzle rows; the worker (Sprint 8.2) projects the
 * real leads/icps/lead_dossiers rows onto these shapes at the call site.
 */

import type {
  AnthropicClient,
  ChannelRecommendation,
  ComposedDraft,
  ComposerChannel,
  ComposerContactData,
  ComposerHookCandidate,
  IcpStarterGuidance,
  OutreachAngle,
  QualityVerdict,
  SelectedHook,
} from '@spleed/integrations/anthropic'

export type { ComposerChannel, ComposerContactData, ChannelRecommendation, IcpStarterGuidance }

/**
 * Lead identity + contact data the Composer renders into prompts and the
 * channel recommendation. `phone` is modeled but unsourced in Sprint 8 (no
 * leads.phone column / extraction yet — Sprint 9+ adds it, BACKLOG-053).
 */
export interface ComposerLeadShape {
  fullName: string
  company: string
  role: string
  companyDomain?: string | null
  email?: string | null
  phone?: string | null
  linkedinUrl?: string | null
}

/**
 * Per-ICP Composer config — projected from the icps row (Sprint 8 columns:
 * preferred_channel, outreach_voice_guidance, outreach_footer_template) plus
 * the industry extracted from parsed_filters.
 */
export interface ComposerIcpConfig {
  name: string
  definitionNaturalLanguage: string
  /** Extracted from icps.parsed_filters.industries[0] (nullable). */
  industry?: string | null
  preferredChannel: ComposerChannel
  voiceGuidance?: string | null
  footerTemplate?: string | null
}

/**
 * Dossier signal inputs — the synthesized hooks (Phase 6/8) plus the deep
 * research recommended hooks (Phase 7) when present. The worker reads these
 * from lead_dossiers.rawSignals.synthesis + .deepResearchSignals.
 */
export interface ComposerDossierInput {
  recommendedAngle: string
  painInferred?: string | null
  confidenceScore: number
  hookCandidates: ComposerHookCandidate[]
  /** Phase 7 recommended_hooks (sourceName='deep_research'). Empty when none. */
  deepResearchHooks?: ComposerHookCandidate[]
}

export interface ComposerInput {
  lead: ComposerLeadShape
  icp: ComposerIcpConfig
  dossier: ComposerDossierInput
  /** Mock-aware client. Sprint 8.2+ swaps in a BYOK-configured instance. */
  anthropicClient: AnthropicClient
}

/** Cost/latency metadata carried by every step + rolled into the breakdown. */
export interface ComposerStepCost {
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

export interface ChannelRecommendationResult extends ComposerStepCost {
  recommendation: ChannelRecommendation
  contactData: ComposerContactData
}
export interface HookSelectionResult extends ComposerStepCost {
  selectedHooks: SelectedHook[]
}
export interface AngleGenerationResult extends ComposerStepCost {
  angle: OutreachAngle
}
export interface DraftCompositionResult extends ComposerStepCost {
  draft: ComposedDraft
}
export interface QualityCheckResult extends ComposerStepCost {
  verdict: QualityVerdict
}

/** Per-step + total cost rollup persisted into outreach_drafts.composer_metadata. */
export interface ComposerCostBreakdown {
  channelRecommendation: ComposerStepCost
  hookSelection: ComposerStepCost
  angleGeneration: ComposerStepCost
  draftComposition: ComposerStepCost
  qualityCheck: ComposerStepCost
  totalTokensIn: number
  totalTokensOut: number
  totalCostUsd: number
  totalLatencyMs: number
}

/**
 * Composer output. Discriminated on `status`: 'composed' (quality passed,
 * ready for approval) vs 'failed_quality' (the draft exists but the quality
 * gate failed — the worker can surface a 🔄 Regenerate, Sprint 8.2). Both
 * carry the draft + cost so the failure is observable, not silent.
 */
export type ComposerOutput =
  | {
      status: 'composed'
      /** Phase 0 recommendation (overrides the ICP default). */
      channel: ComposerChannel
      channelReasoning: string
      channelConfidence: number
      contactData: ComposerContactData
      subject: string | null
      body: string
      selectedHooks: SelectedHook[]
      angle: OutreachAngle
      qualityVerdict: QualityVerdict
      costBreakdown: ComposerCostBreakdown
    }
  | {
      status: 'failed_quality'
      channel: ComposerChannel
      channelReasoning: string
      channelConfidence: number
      contactData: ComposerContactData
      subject: string | null
      body: string
      qualityVerdict: QualityVerdict
      costBreakdown: ComposerCostBreakdown
    }

// ─── Injectable step seams (tests/demo) ─────────────────────────────
// Each defaults to a real AnthropicClient-backed implementation; tests
// override one to assert orchestration in isolation (Sprint 7c pattern).

export type ChannelRecommender = (ctx: { input: ComposerInput }) => Promise<ChannelRecommendationResult>
export type HookSelector = (ctx: { input: ComposerInput }) => Promise<HookSelectionResult>
export type AngleGenerator = (ctx: {
  input: ComposerInput
  selectedHooks: SelectedHook[]
}) => Promise<AngleGenerationResult>
export type DraftComposer = (ctx: {
  input: ComposerInput
  angle: OutreachAngle
}) => Promise<DraftCompositionResult>
export type QualityChecker = (ctx: {
  input: ComposerInput
  draft: ComposedDraft
}) => Promise<QualityCheckResult>

// ─── ICP starter (Hermes, Decision 10) ──────────────────────────────

export interface GenerateIcpStarterInput {
  icpId: string
  icpDescription: string
  icpIndustry?: string | null
  anthropicClient: AnthropicClient
}
export interface IcpStarterResult extends ComposerStepCost {
  icpId: string
  guidance: IcpStarterGuidance
}
