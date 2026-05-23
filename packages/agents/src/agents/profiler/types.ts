/**
 * Profiler agent types (Sprint 6a — company website source only).
 *
 * The raw signals JSON returned by the LLM (@spleed/integrations/anthropic
 * ExtractedCompanyWebsiteSignals) lacks hookId uuids. The Profiler agent
 * layer generates one uuid per hook_candidate and attaches it before
 * persistence — that ID is the bridge between hook_candidates and the
 * evidence_urls jsonb (Sprint 6b screenshot capture writes
 * { hookId, url, capturedAt, sourceType } rows pointing back at hooks).
 */

import type {
  AnthropicClient,
  CompanyStage,
  ExtractedCompanyWebsiteSignals,
  IcpShape,
  ProfilerSourceName,
} from '@spleed/integrations/anthropic'

export type { CompanyStage, ProfilerSourceName }

export interface CompanyWebsiteSignalsWithIds {
  company_stage: ExtractedCompanyWebsiteSignals['company_stage']
  recent_news: string[]
  pain_signals: string[]
  hiring_signals: string[]
  growth_signals: string[]
  hook_candidates: Array<{
    hookId: string
    hook: string
    evidence: string
    confidence: number
  }>
}

export interface ProfilerCompanyWebsiteExtractionResult {
  signals: CompanyWebsiteSignalsWithIds
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

/**
 * Subset of Lead fields Profiler's extraction reads. Leaf-shape pattern
 * (mirrors anthropic IcpShape) keeps tests free of full Drizzle row
 * construction. The worker (Sprint 6a CP3) projects the real `leads` row
 * onto this shape before invoking extractCompanyWebsiteSignals.
 */
export interface LeadShape {
  fullName: string
  firstName: string
  lastName: string
  company: string
  role: string
  /** Apollo + manual ingest both may leave this NULL — guard at consumer. */
  companyDomain?: string | null
  email?: string | null
  linkedinUrl?: string | null
}

// ─── Sprint 6b — LinkedIn + News extraction + Synthesis ────────────

/**
 * Per-source extraction result. LinkedIn and news extractions share the
 * same shape as Sprint 6a's company-website extraction
 * (ProfilerCompanyWebsiteExtractionResult); these aliases name the shape
 * at call sites for readability. Sprint 7+ may diverge per-source types
 * if source-specific fields are added (e.g. LinkedIn connection graph).
 */
export type LinkedinExtractionResult = ProfilerCompanyWebsiteExtractionResult
export type NewsExtractionResult = ProfilerCompanyWebsiteExtractionResult

/**
 * Hook with primary-source attribution, emitted by synthesis. Mirror of
 * @spleed/integrations/anthropic.SynthesizedHookCandidate with a fresh
 * hookId stamped by the agent layer (so dossier.evidence_urls entries
 * can correlate back to the synthesis dossier even when the original
 * extraction-layer hookIds were rolled up).
 */
export interface SynthesizedHookCandidateWithId {
  hookId: string
  hook: string
  evidence: string
  sourceName: ProfilerSourceName
  confidence: number
}

/**
 * Synthesis input from the worker's POV. One entry per successful source
 * extraction; the worker filters out failed sources before passing.
 */
export interface SynthesisSourceInput {
  sourceName: ProfilerSourceName
  signals: CompanyWebsiteSignalsWithIds
}

export interface SynthesisInput {
  sources: SynthesisSourceInput[]
  /** True when sources.length < 3 (1 or 2 sources only). */
  partialEnrichment: boolean
  /** Source names that failed extraction. Empty when partialEnrichment=false. */
  missingSources: ProfilerSourceName[]
  lead: LeadShape
  icp: IcpShape
  anthropicClient: AnthropicClient
}

export interface SynthesizedDossier {
  hookCandidates: SynthesizedHookCandidateWithId[]
  recommendedAngle: string
  painInferred: string
  /** 0-1, scaled down for partial enrichment per PROFILER_SYNTHESIS_PROMPT rules. */
  confidenceScore: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}
