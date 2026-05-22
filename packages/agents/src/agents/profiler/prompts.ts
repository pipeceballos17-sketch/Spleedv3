/**
 * Profiler prompts — Sprint 6a entry points.
 *
 * PROFILER_SYSTEM_PROMPT is re-exported from @spleed/db/seed/prompts so the
 * runtime extraction call and the agent_templates seed row use the SAME
 * string — no drift between what the LLM is told (runtime) and what the
 * dashboard shows the founder (seed -> agent_templates.default_prompt).
 *
 * buildCompanyWebsiteUserPrompt renders the user message for one extraction
 * call. ICP context anchors the LLM first; lead identity second; page
 * content last; then a JSON schema cue at the end as a non-binding reminder.
 */

import type { CompanyWebsitePageContent } from '@spleed/integrations/vercel-browser'
import type { IcpShape } from '@spleed/integrations/anthropic'
import type { LeadShape } from './types'

export { PROFILER_SYSTEM_PROMPT } from '@spleed/db/seed/prompts'

export interface BuildCompanyWebsiteUserPromptInput {
  lead: LeadShape
  icp: IcpShape
  pageContent: CompanyWebsitePageContent
}

/**
 * Compose the user-side message Profiler sends alongside PROFILER_SYSTEM_PROMPT.
 * Sections are stable-ordered so prompt caching can amortize tokens within a
 * profiling batch (system prompt + ICP block stay constant across leads in
 * the same batch — Sprint 6b structured pipeline will rely on this).
 */
export function buildCompanyWebsiteUserPrompt(
  input: BuildCompanyWebsiteUserPromptInput,
): string {
  const { lead, icp, pageContent } = input
  const lines: string[] = []

  lines.push('# ICP')
  lines.push(`Name: ${icp.name}`)
  lines.push(`Definition: ${icp.definitionNaturalLanguage}`)
  const pf = icp.parsedFilters
  if (pf.industries?.length) lines.push(`Target industries: ${pf.industries.join(', ')}`)
  if (pf.titles?.length) lines.push(`Target titles: ${pf.titles.join(', ')}`)
  if (pf.seniorities?.length) lines.push(`Target seniorities: ${pf.seniorities.join(', ')}`)
  if (pf.geos?.length) lines.push(`Geos: ${pf.geos.join(', ')}`)

  lines.push('')
  lines.push('# Lead')
  lines.push(`${lead.fullName} — ${lead.role} at ${lead.company}`)
  if (lead.companyDomain) lines.push(`Domain: ${lead.companyDomain}`)
  if (lead.linkedinUrl) lines.push(`LinkedIn: ${lead.linkedinUrl}`)

  lines.push('')
  lines.push(`# Source: company website (${lead.companyDomain ?? 'unknown domain'})`)
  lines.push(`Page title: ${pageContent.title}`)
  lines.push('')
  lines.push('## Main content')
  lines.push(pageContent.mainText)
  if (pageContent.aboutText) {
    lines.push('')
    lines.push('## About page')
    lines.push(pageContent.aboutText)
  }
  if (pageContent.teamText) {
    lines.push('')
    lines.push('## Team / hiring page')
    lines.push(pageContent.teamText)
  }
  if (pageContent.newsText) {
    lines.push('')
    lines.push('## News / press / blog')
    lines.push(pageContent.newsText)
  }

  lines.push('')
  lines.push('Return ONLY valid JSON matching this schema (no prose, no fences):')
  lines.push('{')
  lines.push('  "company_stage": "pre-seed"|"seed"|"series-a"|"series-b"|"growth"|"enterprise"|"unknown",')
  lines.push('  "recent_news": string[],')
  lines.push('  "pain_signals": string[],')
  lines.push('  "hiring_signals": string[],')
  lines.push('  "growth_signals": string[],')
  lines.push('  "hook_candidates": [ { "hook": string, "evidence": string, "confidence": number } ]')
  lines.push('}')

  return lines.join('\n')
}
