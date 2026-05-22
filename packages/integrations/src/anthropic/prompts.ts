import type { IcpShape, ScoreLeadInput } from './types'
import type { ApolloPerson } from '../apollo/types'

/**
 * Re-rank system prompt. Hardcoded text (NOT per-tenant in Sprint 5b — that
 * lands with Hermes feedback loops in Sprint 8). Designed for prompt-caching:
 * stable across all candidates in a run so the SDK can mark it `cache_control`
 * once and amortize across the parallel calls.
 *
 * Output contract: STRICT JSON with two keys. The parser below is permissive
 * (extracts the first JSON object it finds) so a chatty LLM doesn't fail the
 * whole run.
 */
export const SCOUT_RERANK_PROMPT_SYSTEM = `You are evaluating sales lead fit for a founder-led B2B outreach pipeline.

Given an ICP definition and a candidate, score the candidate 0-100 based on
quality of fit. Consider signals that a literal keyword match (SQL scoring)
will have missed:
  - industry adjacency (e.g. "education" ICP may fit ed-tech SaaS)
  - role nuance (e.g. "Founder" ICP — is a 2-person co-founder team a fit?)
  - geographic relevance (e.g. LatAm-focused founder selling to US prospect)
  - seniority signal vs title literal (e.g. "Director" at a 5-person company ≈ founder)

The SQL baseline score is included so you can use it as an anchor. Adjust UP
when SQL missed clear positive signals; adjust DOWN when SQL was fooled by
substring matches (a "Director of Academics" is not a CTO even if the word
"director" contains the letters "cto").

Respond with strict JSON ONLY — no preamble, no markdown fences:
{ "llmScore": <0-100 integer>, "reasoning": "<one short sentence>" }`

/**
 * Render the per-candidate user message. ICP context comes first so the LLM
 * anchors against it; candidate facts second so the LLM doesn't drift from
 * the framing. Format is intentionally compact — every token paid for at
 * Sonnet 4.6 rates ($3/1M input).
 */
export function buildRerankPrompt(input: ScoreLeadInput): string {
  return [
    renderIcpBlock(input.icp),
    renderCandidateBlock(input.candidate),
    `SQL baseline score: ${input.sqlScore}/100`,
  ].join('\n\n')
}

function renderIcpBlock(icp: IcpShape): string {
  const pf = icp.parsedFilters
  const lines: string[] = [`ICP: ${icp.name}`, icp.definitionNaturalLanguage]
  if (pf.industries?.length) lines.push(`Industries: ${pf.industries.join(', ')}`)
  if (pf.companySizeMin !== undefined || pf.companySizeMax !== undefined) {
    lines.push(
      `Company size: ${pf.companySizeMin ?? '*'}-${pf.companySizeMax ?? '*'} employees`,
    )
  }
  if (pf.geos?.length) lines.push(`Geos: ${pf.geos.join(', ')}`)
  if (pf.titles?.length) lines.push(`Target titles: ${pf.titles.join(', ')}`)
  if (pf.seniorities?.length) lines.push(`Target seniorities: ${pf.seniorities.join(', ')}`)
  if (pf.techStack?.length) lines.push(`Tech preferred: ${pf.techStack.join(', ')}`)
  return lines.join('\n')
}

function renderCandidateBlock(c: ApolloPerson): string {
  const lines: string[] = [
    `Candidate: ${c.full_name} — ${c.title} at ${c.company}`,
  ]
  if (c.industry) lines.push(`Industry: ${c.industry}`)
  if (c.company_size !== undefined) lines.push(`Company size: ${c.company_size}`)
  if (c.location) lines.push(`Location: ${c.location}`)
  if (c.seniority) lines.push(`Seniority: ${c.seniority}`)
  if (c.technologies?.length) lines.push(`Tech stack: ${c.technologies.join(', ')}`)
  return lines.join('\n')
}

/**
 * Parse the LLM response. Permissive: pulls the first balanced JSON object
 * out of the response text (LLMs occasionally add a stray ```json fence or
 * leading whitespace even when told not to). Returns sentinel fallback on
 * malformed input so a single bad candidate doesn't poison the batch.
 */
export function parseRerankResponse(raw: string): {
  llmScore: number
  reasoning: string
} {
  const match = raw.match(/\{[\s\S]*?\}/)
  if (!match) {
    return { llmScore: 0, reasoning: 'PARSE_FAILED: no JSON object found' }
  }
  try {
    const parsed = JSON.parse(match[0]) as { llmScore?: unknown; reasoning?: unknown }
    const score = typeof parsed.llmScore === 'number' ? parsed.llmScore : 0
    const reasoning =
      typeof parsed.reasoning === 'string' ? parsed.reasoning : 'PARSE_FAILED: missing reasoning'
    return {
      llmScore: Math.min(100, Math.max(0, Math.round(score))),
      reasoning: reasoning.slice(0, 500),
    }
  } catch {
    return { llmScore: 0, reasoning: 'PARSE_FAILED: malformed JSON' }
  }
}
