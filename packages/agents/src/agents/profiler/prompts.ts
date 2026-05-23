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

import type { LinkedinPost, LinkedinProfile } from '@spleed/integrations/apify'
import type { IcpShape } from '@spleed/integrations/anthropic'
import type { CompanyWebsitePageContent, NewsArticle } from '@spleed/integrations/vercel-browser'
import type {
  LeadShape,
  ProfilerSourceName,
  SynthesisSourceInput,
} from './types'

export { PROFILER_SYNTHESIS_PROMPT, PROFILER_SYSTEM_PROMPT } from '@spleed/db/seed/prompts'

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

// ─── Sprint 6b — LinkedIn user prompt ──────────────────────────────

export interface BuildLinkedinUserPromptInput {
  lead: LeadShape
  icp: IcpShape
  profile: LinkedinProfile
  posts: LinkedinPost[]
}

/**
 * Compose the user-side message for LinkedIn extraction. ICP first (anchor),
 * then lead identity, then profile + recent posts. Posts are formatted with
 * recency so the LLM can prioritize fresh signals over older ones.
 */
export function buildLinkedinUserPrompt(
  input: BuildLinkedinUserPromptInput,
): string {
  const { lead, icp, profile, posts } = input
  const lines: string[] = []

  lines.push('# ICP')
  lines.push(`Name: ${icp.name}`)
  lines.push(`Definition: ${icp.definitionNaturalLanguage}`)
  const pf = icp.parsedFilters
  if (pf.industries?.length) lines.push(`Target industries: ${pf.industries.join(', ')}`)
  if (pf.titles?.length) lines.push(`Target titles: ${pf.titles.join(', ')}`)

  lines.push('')
  lines.push('# Lead')
  lines.push(`${lead.fullName} — ${lead.role} at ${lead.company}`)
  if (lead.linkedinUrl) lines.push(`LinkedIn: ${lead.linkedinUrl}`)

  lines.push('')
  lines.push('# Source: LinkedIn profile + recent posts')
  lines.push(`Headline: ${profile.headline}`)
  if (profile.about) {
    lines.push('')
    lines.push('## About')
    lines.push(profile.about)
  }
  if (profile.currentPosition) {
    lines.push('')
    lines.push('## Current position')
    lines.push(`${profile.currentPosition.title} at ${profile.currentPosition.company} (since ${profile.currentPosition.startDate})`)
    if (profile.currentPosition.description) {
      lines.push(profile.currentPosition.description)
    }
  }
  if (profile.experience.length > 1) {
    lines.push('')
    lines.push('## Prior experience')
    // Skip [0] which is the current position already rendered.
    for (const exp of profile.experience.slice(1, 4)) {
      lines.push(`- ${exp.title} at ${exp.company} (${exp.startDate} → ${exp.endDate ?? 'now'})`)
    }
  }

  if (posts.length > 0) {
    lines.push('')
    lines.push(`## Recent posts (${posts.length})`)
    for (const post of posts) {
      lines.push(`- [${post.postedAt}] ${post.content} (${post.reactions} reactions, ${post.comments} comments)`)
    }
  } else {
    lines.push('')
    lines.push('## Recent posts')
    lines.push('No recent posts surfaced.')
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

// ─── Sprint 6b — News user prompt ──────────────────────────────────

export interface BuildNewsUserPromptInput {
  lead: LeadShape
  icp: IcpShape
  articles: NewsArticle[]
}

/**
 * Compose the user-side message for news extraction. Articles are listed
 * with publisher + date + snippet so the LLM can favor authoritative
 * sources (TechCrunch, WSJ) over thin aggregators.
 */
export function buildNewsUserPrompt(input: BuildNewsUserPromptInput): string {
  const { lead, icp, articles } = input
  const lines: string[] = []

  lines.push('# ICP')
  lines.push(`Name: ${icp.name}`)
  lines.push(`Definition: ${icp.definitionNaturalLanguage}`)
  if (icp.parsedFilters.industries?.length) {
    lines.push(`Target industries: ${icp.parsedFilters.industries.join(', ')}`)
  }

  lines.push('')
  lines.push('# Lead')
  lines.push(`${lead.fullName} — ${lead.role} at ${lead.company}`)
  if (lead.companyDomain) lines.push(`Domain: ${lead.companyDomain}`)

  lines.push('')
  lines.push(`# Source: Google News results (${articles.length} articles)`)
  if (articles.length === 0) {
    lines.push('No recent articles surfaced for this company.')
  } else {
    for (const article of articles) {
      lines.push('')
      lines.push(`## ${article.title}`)
      lines.push(`Source: ${article.source}  ·  Published: ${article.publishedAt}`)
      lines.push(`URL: ${article.url}`)
      lines.push(article.snippet)
    }
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

// ─── Sprint 6b — Synthesis user prompt ─────────────────────────────

export interface BuildSynthesisUserPromptInput {
  lead: LeadShape
  icp: IcpShape
  sources: SynthesisSourceInput[]
  missingSources: ProfilerSourceName[]
}

/**
 * Compose the user-side message for synthesis. Lists each successful
 * source extraction in turn (company_website → linkedin → news) so the
 * LLM sees the same ordering across runs (prompt-cache friendly within
 * a profiling batch). Missing sources are flagged so the LLM knows to
 * scale confidence down per PROFILER_SYNTHESIS_PROMPT rules.
 */
export function buildSynthesisUserPrompt(
  input: BuildSynthesisUserPromptInput,
): string {
  const { lead, icp, sources, missingSources } = input
  const lines: string[] = []

  lines.push('# ICP')
  lines.push(`Name: ${icp.name}`)
  lines.push(`Definition: ${icp.definitionNaturalLanguage}`)

  lines.push('')
  lines.push('# Lead')
  lines.push(`${lead.fullName} — ${lead.role} at ${lead.company}`)
  if (lead.companyDomain) lines.push(`Domain: ${lead.companyDomain}`)
  if (lead.linkedinUrl) lines.push(`LinkedIn: ${lead.linkedinUrl}`)

  lines.push('')
  lines.push(`# Source extractions (${sources.length} of 3)`)
  if (missingSources.length > 0) {
    lines.push(`Missing: ${missingSources.join(', ')}`)
  }

  // Stable source ordering — company_website first, then linkedin, then news.
  // Matches PROFILER_SYNTHESIS_PROMPT dedup hierarchy (news wins on conflict).
  const ORDER: ProfilerSourceName[] = ['company_website', 'linkedin', 'news']
  const sourcesByOrder = ORDER.map((name) => sources.find((s) => s.sourceName === name)).filter(
    (s): s is SynthesisSourceInput => s !== undefined,
  )

  for (const source of sourcesByOrder) {
    lines.push('')
    lines.push(`## Source: ${source.sourceName}`)
    lines.push(`company_stage: ${source.signals.company_stage}`)
    if (source.signals.recent_news.length > 0) {
      lines.push(`recent_news: ${source.signals.recent_news.join(' | ')}`)
    }
    if (source.signals.pain_signals.length > 0) {
      lines.push(`pain_signals: ${source.signals.pain_signals.join(' | ')}`)
    }
    if (source.signals.hiring_signals.length > 0) {
      lines.push(`hiring_signals: ${source.signals.hiring_signals.join(' | ')}`)
    }
    if (source.signals.growth_signals.length > 0) {
      lines.push(`growth_signals: ${source.signals.growth_signals.join(' | ')}`)
    }
    if (source.signals.hook_candidates.length > 0) {
      lines.push('hook_candidates:')
      for (const hc of source.signals.hook_candidates) {
        lines.push(`  - hook: ${hc.hook}`)
        lines.push(`    evidence: ${hc.evidence}`)
        lines.push(`    confidence: ${hc.confidence}`)
      }
    }
  }

  lines.push('')
  lines.push('Return ONLY valid JSON matching this schema (no prose, no fences):')
  lines.push('{')
  lines.push('  "hook_candidates": [ { "hook": string, "evidence": string, "sourceName": "company_website"|"linkedin"|"news", "confidence": number } ],')
  lines.push('  "recommended_angle": string,')
  lines.push('  "pain_inferred": string,')
  lines.push('  "confidence_score": number')
  lines.push('}')

  return lines.join('\n')
}
