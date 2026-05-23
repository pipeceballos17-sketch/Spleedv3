/**
 * Profiler — Synthesis (Sprint 6b, structured pipeline phase 4 of 4).
 *
 * Consolidates 1-3 successful source extractions into a single ranked
 * dossier. Caller (Sprint 6b worker phase 6) supplies only successful
 * sources; failed sources are listed in `missingSources` so the LLM
 * (and the mock) can scale confidence down per PROFILER_SYNTHESIS_PROMPT.
 *
 * Returns dossier-level metadata (recommended_angle, pain_inferred,
 * confidence_score) PLUS deduplicated hook_candidates with primary-
 * source attribution. The worker then projects these onto
 * lead_dossiers columns (pains, interests, rawSignals.synthesis,
 * confidenceScore).
 */

import { PROFILER_SYNTHESIS_PROMPT, buildSynthesisUserPrompt } from './prompts'
import type { SynthesisInput, SynthesizedDossier } from './types'

export async function synthesizeDossier(
  input: SynthesisInput,
): Promise<SynthesizedDossier> {
  if (input.sources.length === 0) {
    // Caller (worker) MUST detect zero-source case before invoking this.
    // We throw loud so a silent dossier with confidence=0 doesn't leak.
    throw new Error(
      'SYNTHESIS_NO_SOURCES: synthesizeDossier called with empty sources array',
    )
  }

  const sourcesCount = input.sources.length as 1 | 2 | 3
  const availableSources = input.sources.map((s) => s.sourceName)

  const userPrompt = buildSynthesisUserPrompt({
    lead: input.lead,
    icp: input.icp,
    sources: input.sources,
    missingSources: input.missingSources,
  })

  const result = await input.anthropicClient.synthesizeDossier({
    systemPrompt: PROFILER_SYNTHESIS_PROMPT,
    userPrompt,
    domainHint: input.lead.companyDomain ?? input.lead.company,
    sourcesCount,
    availableSources,
  })

  // Stamp fresh hookIds on synthesis output. These are SEPARATE from
  // extraction-layer hookIds (which keyed screenshot evidence_urls
  // entries) — synthesis represents a dedup'd narrative that may roll
  // up 1-3 extraction hooks into one. Sprint 7+ may correlate the two
  // sets if Composer needs evidence_urls per synthesis hook; today
  // evidence_urls remains keyed by extraction-layer hookIds.
  const hookCandidates = result.dossier.hook_candidates.map((hc) => ({
    hookId: crypto.randomUUID(),
    hook: hc.hook,
    evidence: hc.evidence,
    sourceName: hc.sourceName,
    confidence: hc.confidence,
  }))

  return {
    hookCandidates,
    recommendedAngle: result.dossier.recommended_angle,
    painInferred: result.dossier.pain_inferred,
    confidenceScore: result.dossier.confidence_score,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
  }
}
