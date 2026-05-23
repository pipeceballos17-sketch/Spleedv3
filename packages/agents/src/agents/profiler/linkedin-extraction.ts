/**
 * Profiler — LinkedIn extraction (Sprint 6b, source 2 of 3).
 *
 * Mirrors the company-website-extraction shape: build prompt → call
 * AnthropicClient.extractLinkedinSignals (mock-default) → stamp hookId
 * uuids → return ProfilerCompanyWebsiteExtractionResult-shaped result.
 *
 * The profile + posts are paired by the worker before calling this
 * function (Apify scrapeLinkedinProfile + scrapeLinkedinPosts run in
 * parallel; failures classified per Sprint 5b withTransientRetry).
 */

import type { LinkedinPost, LinkedinProfile } from '@spleed/integrations/apify'
import type { AnthropicClient, IcpShape } from '@spleed/integrations/anthropic'
import { buildLinkedinUserPrompt, PROFILER_SYSTEM_PROMPT } from './prompts'
import type { LeadShape, LinkedinExtractionResult } from './types'

export interface ExtractLinkedinSignalsInput {
  profile: LinkedinProfile
  posts: LinkedinPost[]
  lead: LeadShape
  icp: IcpShape
  anthropicClient: AnthropicClient
}

export async function extractLinkedinSignals(
  input: ExtractLinkedinSignalsInput,
): Promise<LinkedinExtractionResult> {
  const userPrompt = buildLinkedinUserPrompt({
    lead: input.lead,
    icp: input.icp,
    profile: input.profile,
    posts: input.posts,
  })

  const result = await input.anthropicClient.extractLinkedinSignals({
    systemPrompt: PROFILER_SYSTEM_PROMPT,
    userPrompt,
    linkedinUrlHint: input.lead.linkedinUrl ?? undefined,
  })

  // Stamp fresh hookIds — Sprint 6b worker uses these as evidence_urls
  // join keys for screenshots taken DURING this extraction (per Decision
  // 5: screenshots captured inline while the Apify dataset is open).
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
