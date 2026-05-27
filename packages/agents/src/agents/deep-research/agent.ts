/**
 * DeepResearchAgent (Sprint 7b — Phase 7).
 *
 * Orchestrates a deep-research session: builds prompts, invokes
 * AnthropicClient.researchDeep (Opus 4.7 + tools, mock-default), returns
 * the structured 4-category output the Profiler worker persists + feeds
 * to Phase 8 final synthesis.
 *
 * The Apify + Vercel clients are injected so the live tool-use loop
 * (Sprint 8+) can route the model's scrape_linkedin_profile /
 * scrape_company_website tool calls through Spleed-managed scrapers.
 * In Sprint 7b mock mode those handlers are built but not invoked.
 */

import {
  AnthropicClient,
  type DeepResearchOutput,
} from '@spleed/integrations/anthropic'
import type { ApifyClient } from '@spleed/integrations/apify'
import type { VercelBrowserClient } from '@spleed/integrations/vercel-browser'
import { DEEP_RESEARCH_PROMPT, buildDeepResearchUserPrompt } from './prompts'
import { createToolHandlers, type DeepResearchToolHandlers } from './tool-handlers'
import type { DeepResearchInput } from './types'

export class DeepResearchAgent {
  private readonly anthropic: AnthropicClient
  /** Built for the Sprint 8+ live tool-use loop; unused in mock mode. */
  private readonly toolHandlers: DeepResearchToolHandlers

  constructor(deps: {
    anthropicClient: AnthropicClient
    apifyClient: ApifyClient
    vercelBrowserClient: VercelBrowserClient
  }) {
    this.anthropic = deps.anthropicClient
    this.toolHandlers = createToolHandlers({
      apifyClient: deps.apifyClient,
      vercelBrowserClient: deps.vercelBrowserClient,
    })
  }

  /**
   * Run deep research for one lead. Returns the 4-category dossier plus
   * cost/latency metadata. Mock-default returns curated fixtures; live
   * mode (Sprint 8+) drives the Opus tool-use loop with `this.toolHandlers`.
   */
  async research(input: DeepResearchInput): Promise<DeepResearchOutput> {
    const userPrompt = buildDeepResearchUserPrompt({
      lead: input.lead,
      icp: input.icp,
      guidance: input.guidance,
      initialSynthesis: input.initialSynthesis,
    })

    return this.anthropic.researchDeep({
      systemPrompt: DEEP_RESEARCH_PROMPT,
      userPrompt,
      domainHint: input.lead.companyDomain ?? input.lead.company ?? undefined,
    })
  }

  /** Expose the tool handlers for the Sprint 8+ live researchDeep wiring. */
  getToolHandlers(): DeepResearchToolHandlers {
    return this.toolHandlers
  }
}
