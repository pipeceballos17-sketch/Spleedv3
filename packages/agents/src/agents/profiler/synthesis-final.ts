/**
 * Profiler — final synthesis (Sprint 7b, Phase 8).
 *
 * Consolidates the 1-3 initial sources (Phase 5) PLUS the deep research
 * dossier (Phase 7) into the final outreach dossier. Runs only when Phase
 * 7 produced output. Confidence ceiling 0.95 (vs Phase 6's 0.85) when deep
 * research surfaced substantive findings.
 *
 * Mirrors synthesis.ts (Phase 6) shape — returns SynthesizedDossier with
 * fresh hookIds — but uses PROFILER_SYNTHESIS_FINAL_PROMPT and weights
 * deep-research specificity higher.
 */

import { PROFILER_SYNTHESIS_FINAL_PROMPT } from '@spleed/db/seed/prompts'
import type {
  AnthropicClient,
  DeepResearchOutput,
  IcpShape,
} from '@spleed/integrations/anthropic'
import type {
  LeadShape,
  SynthesisSourceInput,
  SynthesizedDossier,
} from './types'

/** True when deep research surfaced anything actionable. Drives the confidence boost. */
export function deepResearchHasFindings(dr: DeepResearchOutput): boolean {
  return (
    dr.succession_signals.findings.length > 0 ||
    dr.hiring_signals.findings.length > 0 ||
    dr.tech_stack_signals.findings.length > 0 ||
    dr.recent_activity_signals.findings.length > 0 ||
    dr.recommended_hooks.length > 0
  )
}

export interface SynthesizeFinalDossierInput {
  sources: SynthesisSourceInput[]
  deepResearchOutput: DeepResearchOutput
  initialSynthesis: SynthesizedDossier
  lead: LeadShape
  icp: IcpShape
  anthropicClient: AnthropicClient
}

function buildSynthesisFinalUserPrompt(input: SynthesizeFinalDossierInput): string {
  const { sources, deepResearchOutput, initialSynthesis, lead, icp } = input
  const lines: string[] = []

  lines.push('# Lead')
  lines.push(`${lead.fullName ?? '(pending)'} — ${lead.role ?? 'unknown'} at ${lead.company ?? lead.companyDomain ?? 'unknown'}`)

  lines.push('')
  lines.push('# ICP')
  lines.push(`${icp.name}: ${icp.definitionNaturalLanguage}`)

  lines.push('')
  lines.push(`# Initial sources (Phase 5, ${sources.length} of 3)`)
  for (const src of sources) {
    lines.push(`## ${src.sourceName}`)
    if (src.signals.hook_candidates.length > 0) {
      for (const hc of src.signals.hook_candidates) {
        lines.push(`  - ${hc.hook} (evidence: ${hc.evidence}; confidence ${hc.confidence})`)
      }
    } else {
      lines.push('  (no hooks)')
    }
  }

  lines.push('')
  lines.push('# Phase 6 initial synthesis (for reference)')
  lines.push(`Confidence: ${initialSynthesis.confidenceScore}`)
  lines.push(`Recommended angle: ${initialSynthesis.recommendedAngle}`)
  lines.push(`Pain inferred: ${initialSynthesis.painInferred}`)

  lines.push('')
  lines.push('# Deep research dossier (Phase 7)')
  const categories: Array<[string, DeepResearchOutput[keyof DeepResearchOutput]]> = [
    ['SUCCESSION', deepResearchOutput.succession_signals],
    ['HIRING', deepResearchOutput.hiring_signals],
    ['TECH STACK', deepResearchOutput.tech_stack_signals],
    ['RECENT ACTIVITY', deepResearchOutput.recent_activity_signals],
  ]
  for (const [label, cat] of categories) {
    const category = cat as { findings: Array<{ signal: string; evidence: string; source_url?: string; confidence: number }>; summary: string }
    lines.push(`## ${label}`)
    lines.push(`Summary: ${category.summary || '(none)'}`)
    for (const f of category.findings) {
      lines.push(`  - ${f.signal} | ${f.evidence}${f.source_url ? ` | ${f.source_url}` : ''} (confidence ${f.confidence})`)
    }
  }
  if (deepResearchOutput.recommended_hooks.length > 0) {
    lines.push('## Deep research recommended hooks')
    for (const h of deepResearchOutput.recommended_hooks) {
      lines.push(`  - ${h.hook} (evidence: ${h.evidence}; confidence ${h.confidence})`)
    }
  }

  lines.push('')
  lines.push('Return ONLY valid JSON: { hook_candidates: [{ hook, evidence, sourceName, confidence }], recommended_angle, pain_inferred, confidence_score }')

  return lines.join('\n')
}

export async function synthesizeFinalDossier(
  input: SynthesizeFinalDossierInput,
): Promise<SynthesizedDossier> {
  const userPrompt = buildSynthesisFinalUserPrompt(input)

  const result = await input.anthropicClient.synthesizeFinal({
    systemPrompt: PROFILER_SYNTHESIS_FINAL_PROMPT,
    userPrompt,
    domainHint: input.lead.companyDomain ?? input.lead.company ?? undefined,
    // sources.length is 1-3 (worker rejects 0-source via Phase 5b before
    // reaching synthesis).
    sourcesCount: input.sources.length as 1 | 2 | 3,
    deepResearchHasFindings: deepResearchHasFindings(input.deepResearchOutput),
    initialConfidence: input.initialSynthesis.confidenceScore,
  })

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
