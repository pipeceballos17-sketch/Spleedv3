/**
 * Profiler — company website extraction (Sprint 6a, source 1 of 3).
 *
 * Calls AnthropicClient.extractCompanyWebsiteSignals (mock-default), layers
 * hookId uuids onto each hook_candidate, returns a Profiler-side result
 * the worker can map into lead_dossiers columns.
 *
 * Sprint 6b expands this module: scrapeNewsArticle + scrapeLinkedinProfile
 * become sibling extraction functions, and a structured-pipeline synthesis
 * call composes the three into a single dossier (per Decision 3).
 */

import type { AnthropicClient, IcpShape } from '@spleed/integrations/anthropic'
import type { CompanyWebsitePageContent } from '@spleed/integrations/vercel-browser'
import { buildCompanyWebsiteUserPrompt, PROFILER_SYSTEM_PROMPT } from './prompts'
import type {
  LeadShape,
  ProfilerCompanyWebsiteExtractionResult,
} from './types'

export interface ExtractCompanyWebsiteSignalsInput {
  pageContent: CompanyWebsitePageContent
  lead: LeadShape
  icp: IcpShape
  /**
   * Mock-aware client. Sprint 7+ swaps in a real-mode instance configured
   * with per-tenant Vault credentials (BACKLOG-027 BYOK).
   */
  anthropicClient: AnthropicClient
}

export async function extractCompanyWebsiteSignals(
  input: ExtractCompanyWebsiteSignalsInput,
): Promise<ProfilerCompanyWebsiteExtractionResult> {
  const userPrompt = buildCompanyWebsiteUserPrompt({
    lead: input.lead,
    icp: input.icp,
    pageContent: input.pageContent,
  })

  // Mock returns curated signals by domainHint. Live (Sprint 7+) calls
  // @anthropic-ai/sdk Messages.create with system prompt cache_control=ephemeral.
  const result = await input.anthropicClient.extractCompanyWebsiteSignals({
    systemPrompt: PROFILER_SYSTEM_PROMPT,
    userPrompt,
    domainHint: input.lead.companyDomain ?? input.lead.company,
  })

  // Each hookId is fresh per extraction call — a re-extraction overwrites
  // old hooks (Sprint 6 Decision 6: once-and-forget; smart refresh deferred
  // to BACKLOG-038). evidence_urls rows keyed on hookId become stale together.
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
