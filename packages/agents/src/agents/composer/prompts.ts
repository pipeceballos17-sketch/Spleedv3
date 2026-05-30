/**
 * Composer prompts — Sprint 8.1 entry points.
 *
 * The 5 system prompts are re-exported from @spleed/db/seed/prompts so the
 * runtime calls and the seeded agent_templates rows use the SAME strings
 * (same lockstep pattern as profiler/concierge). The build*UserPrompt helpers
 * render each step's user turn; sections are stable-ordered for prompt-cache
 * amortization across a compose batch.
 */

import type {
  ComposerInput,
  ComposerChannel,
} from './types'
import type {
  ComposedDraft,
  OutreachAngle,
  SelectedHook,
} from '@spleed/integrations/anthropic'

export {
  COMPOSER_CHANNEL_RECOMMENDATION_PROMPT,
  COMPOSER_HOOK_SELECTION_PROMPT,
  COMPOSER_ANGLE_GENERATION_PROMPT,
  COMPOSER_DRAFT_COMPOSITION_PROMPT,
  COMPOSER_QUALITY_CHECK_PROMPT,
  ICP_STARTER_GUIDANCE_PROMPT,
} from '@spleed/db/seed/prompts'

// ─── Phase 0 — channel recommendation ───────────────────────────────
export function buildChannelRecommendationPrompt(input: ComposerInput): string {
  const { lead, icp, dossier } = input
  const lines: string[] = [...icpBlock(input), '', ...leadBlock(input), '']
  lines.push('# Contact data')
  lines.push(`Email: ${lead.email ?? '(none)'}`)
  lines.push(`Phone: ${lead.phone ?? '(none)'}`)
  lines.push(`LinkedIn: ${lead.linkedinUrl ?? '(none)'}`)
  // Recent-activity deep-research hooks hint at channel receptivity.
  if (dossier.deepResearchHooks && dossier.deepResearchHooks.length > 0) {
    lines.push('', '# Recent activity signals')
    for (const h of dossier.deepResearchHooks) lines.push(`- ${h.hook}`)
  }
  lines.push(
    '',
    `ICP default channel: ${icp.preferredChannel}`,
    'Return ONLY valid JSON: { "channel": "email"|"imessage"|"manual_lookup_required", "reasoning": string, "confidence": number }',
  )
  return lines.join('\n')
}

function icpBlock(input: ComposerInput): string[] {
  const { icp } = input
  const lines = ['# ICP', `Name: ${icp.name}`, `Definition: ${icp.definitionNaturalLanguage}`]
  if (icp.industry) lines.push(`Industry: ${icp.industry}`)
  lines.push(`Preferred channel: ${icp.preferredChannel}`)
  lines.push(`Voice guidance: ${icp.voiceGuidance ?? '(none — use a neutral professional default)'}`)
  return lines
}

function leadBlock(input: ComposerInput): string[] {
  const { lead } = input
  const lines = ['# Lead', `${lead.fullName} — ${lead.role} at ${lead.company}`]
  if (lead.companyDomain) lines.push(`Domain: ${lead.companyDomain}`)
  return lines
}

// ─── Step 1 — hook selection ────────────────────────────────────────
export function buildHookSelectionPrompt(input: ComposerInput): string {
  const { dossier } = input
  const lines: string[] = [...icpBlock(input), '', ...leadBlock(input), '']
  lines.push('# Dossier')
  lines.push(`Recommended angle: ${dossier.recommendedAngle}`)
  if (dossier.painInferred) lines.push(`Pain inferred: ${dossier.painInferred}`)
  lines.push(`Confidence: ${dossier.confidenceScore.toFixed(2)}`)

  lines.push('', '## Synthesized hooks')
  if (dossier.hookCandidates.length === 0) {
    lines.push('(none — dossier is thin)')
  } else {
    for (const h of dossier.hookCandidates) {
      lines.push(`- [${h.sourceName}] ${h.hook} (confidence ${h.confidence.toFixed(2)})`)
      if (h.evidence) lines.push(`    evidence: ${h.evidence}`)
    }
  }

  if (dossier.deepResearchHooks && dossier.deepResearchHooks.length > 0) {
    lines.push('', '## Deep research hooks (weight higher for specificity)')
    for (const h of dossier.deepResearchHooks) {
      lines.push(`- ${h.hook} (confidence ${h.confidence.toFixed(2)})`)
      if (h.evidence) lines.push(`    evidence: ${h.evidence}`)
    }
  }

  lines.push('', 'Return ONLY valid JSON: { "selected_hooks": [ { "hook": string, "reasoning": string, "confidence": number } ] }')
  return lines.join('\n')
}

// ─── Step 2 — angle generation ──────────────────────────────────────
export function buildAngleGenerationPrompt(input: ComposerInput, selectedHooks: SelectedHook[]): string {
  const lines: string[] = [...icpBlock(input), '', ...leadBlock(input), '']
  lines.push('# Selected hooks')
  for (const h of selectedHooks) {
    lines.push(`- ${h.hook}`)
    lines.push(`    why: ${h.reasoning}`)
  }
  lines.push('', 'Return ONLY valid JSON: { "opener": string, "value_proposition": string, "cta": string }')
  return lines.join('\n')
}

// ─── Step 3 — draft composition ─────────────────────────────────────
export function buildDraftCompositionPrompt(input: ComposerInput, angle: OutreachAngle): string {
  const { icp } = input
  const lines: string[] = [...icpBlock(input), '', ...leadBlock(input), '']
  lines.push('# Angle')
  lines.push(`Opener: ${angle.opener}`)
  lines.push(`Value proposition: ${angle.valueProposition}`)
  lines.push(`CTA: ${angle.cta}`)
  lines.push('', `# Channel: ${icp.preferredChannel}`)
  lines.push(`# Footer template: ${icp.footerTemplate ?? '(none — append a minimal opt-out + sender line)'}`)
  lines.push(
    '',
    icp.preferredChannel === 'imessage'
      ? 'Return ONLY valid JSON: { "subject": null, "body": string }  // body 30-80 words, no subject'
      : 'Return ONLY valid JSON: { "subject": string, "body": string }  // subject 5-10 words, body 80-150 words',
  )
  return lines.join('\n')
}

// ─── Step 4 — quality / compliance check ────────────────────────────
export function buildQualityCheckPrompt(
  input: ComposerInput,
  draft: ComposedDraft,
  channel: ComposerChannel,
): string {
  const lines: string[] = []
  lines.push(`# Channel: ${channel}`)
  lines.push(`# Footer template: ${input.icp.footerTemplate ?? '(none provided)'}`)
  lines.push('', '# Draft')
  if (draft.subject) lines.push(`Subject: ${draft.subject}`)
  lines.push('Body:')
  lines.push(draft.body)
  lines.push(
    '',
    'Return ONLY valid JSON: { "passed": boolean, "issues": [string], "markers_found": [string] }',
  )
  return lines.join('\n')
}

// ─── ICP starter guidance ───────────────────────────────────────────
export function buildIcpStarterGuidancePrompt(input: {
  icpDescription: string
  icpIndustry?: string | null
}): string {
  const lines: string[] = ['# ICP description', input.icpDescription]
  if (input.icpIndustry) lines.push('', `# Detected industry: ${input.icpIndustry}`)
  lines.push(
    '',
    'Return ONLY valid JSON: { "voice_guidance": string, "footer_template": string }',
  )
  return lines.join('\n')
}
