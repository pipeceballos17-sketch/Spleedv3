/**
 * Profiler — Google News extraction (Sprint 6b, source 3 of 3).
 *
 * Mirrors linkedin-extraction shape: build prompt → call
 * AnthropicClient.extractNewsSignals → stamp hookId uuids → return
 * ProfilerCompanyWebsiteExtractionResult-shaped result.
 *
 * Articles arrive pre-scraped from VercelBrowserClient.scrapeGoogleNews;
 * the worker passes them in along with lead + ICP context. The mock
 * extraction looks signals up by domainHint so curated news signals
 * stay aligned with the Vercel browser news fixtures.
 */

import type { AnthropicClient, IcpShape } from '@spleed/integrations/anthropic'
import type { NewsArticle } from '@spleed/integrations/vercel-browser'
import { buildNewsUserPrompt, PROFILER_SYSTEM_PROMPT } from './prompts'
import type { LeadShape, NewsExtractionResult } from './types'

export interface ExtractNewsSignalsInput {
  articles: NewsArticle[]
  lead: LeadShape
  icp: IcpShape
  anthropicClient: AnthropicClient
}

export async function extractNewsSignals(
  input: ExtractNewsSignalsInput,
): Promise<NewsExtractionResult> {
  const userPrompt = buildNewsUserPrompt({
    lead: input.lead,
    icp: input.icp,
    articles: input.articles,
  })

  const result = await input.anthropicClient.extractNewsSignals({
    systemPrompt: PROFILER_SYSTEM_PROMPT,
    userPrompt,
    domainHint: input.lead.companyDomain ?? input.lead.company,
  })

  const hookCandidates = result.signals.hook_candidates.map((hc) => ({
    hookId: crypto.randomUUID(),
    hook: hc.hook,
    evidence: hc.evidence,
    confidence: hc.confidence,
  }))

  return {
    signals: {
      company_stage: result.signals.company_stage,
      recent_news: result.signals.recent_news,
      pain_signals: result.signals.pain_signals,
      hiring_signals: result.signals.hiring_signals,
      growth_signals: result.signals.growth_signals,
      hook_candidates: hookCandidates,
    },
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
  }
}
