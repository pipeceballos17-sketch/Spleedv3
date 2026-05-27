/**
 * Deep research prompts (Sprint 7b).
 *
 * DEEP_RESEARCH_PROMPT (system) is owned by @spleed/db/seed/prompts so the
 * seeded agent_templates row and the runtime call stay in lockstep (same
 * pattern as PROFILER_SYSTEM_PROMPT). buildDeepResearchUserPrompt injects
 * lead/ICP/initial-synthesis context + tenant guidance into the user
 * message.
 */

import type { IcpShape } from '@spleed/integrations/anthropic'
import type { LeadShape, SynthesizedDossier } from '../profiler/types'

export { DEEP_RESEARCH_PROMPT } from '@spleed/db/seed/prompts'

export interface BuildDeepResearchUserPromptInput {
  lead: LeadShape
  icp: IcpShape
  guidance: string | null
  initialSynthesis: SynthesizedDossier
}

/**
 * Render the user-side message for a deep-research session. Order: lead
 * identity → ICP context → initial dossier findings (so the LLM knows
 * what's already covered) → tenant guidance (steers source priority).
 */
export function buildDeepResearchUserPrompt(
  input: BuildDeepResearchUserPromptInput,
): string {
  const { lead, icp, guidance, initialSynthesis } = input
  const lines: string[] = []

  lines.push('LEAD CONTEXT:')
  lines.push(`${lead.fullName ?? '(name pending enrichment)'} — ${lead.role ?? 'unknown role'} at ${lead.company ?? lead.companyDomain ?? 'unknown company'}`)
  if (lead.companyDomain) lines.push(`Company domain: ${lead.companyDomain}`)
  if (lead.linkedinUrl) lines.push(`LinkedIn: ${lead.linkedinUrl}`)

  lines.push('')
  lines.push('ICP CONTEXT:')
  // IcpShape has no single `industry` field — derive from parsedFilters.
  const industries = icp.parsedFilters.industries?.join(', ') ?? 'unspecified'
  lines.push(`Industry: ${industries}`)
  lines.push(`Description: ${icp.definitionNaturalLanguage}`)

  lines.push('')
  lines.push('INITIAL DOSSIER FINDINGS (Phase 6 synthesis):')
  lines.push(`Confidence: ${initialSynthesis.confidenceScore}`)
  lines.push(`Pain inferred: ${initialSynthesis.painInferred}`)
  lines.push(`Recommended angle: ${initialSynthesis.recommendedAngle}`)
  const topHooks = initialSynthesis.hookCandidates.slice(0, 3).map((h) => h.hook)
  if (topHooks.length > 0) {
    lines.push('Top hooks already found:')
    for (const hook of topHooks) lines.push(`  - ${hook}`)
  }

  lines.push('')
  lines.push('TENANT-PROVIDED RESEARCH GUIDANCE:')
  lines.push(
    guidance && guidance.trim().length > 0
      ? guidance.trim()
      : 'No additional guidance provided. Apply universal core 4 with standard public sources.',
  )

  lines.push('')
  lines.push(
    'Return JSON matching the DeepResearchOutput schema (succession_signals, hiring_signals, tech_stack_signals, recent_activity_signals, recommended_hooks). Each signal category is { findings: [{ signal, evidence, source_url?, confidence }], summary }.',
  )

  return lines.join('\n')
}
