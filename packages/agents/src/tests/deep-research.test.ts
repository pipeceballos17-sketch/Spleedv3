/**
 * Sprint 7b deep research unit tests.
 *
 * Pure-unit (no DB): construct DeepResearchAgent + synthesizeFinalDossier
 * with mock clients and assert structured output + confidence calibration.
 *
 * Coverage (7 tests):
 *   - DeepResearchAgent happy path (4 categories + cost)
 *   - ICP guidance injection (provided + null)
 *   - Industry-aware emphasis (Mariana / commercial-lending simulation)
 *   - synthesizeFinalDossier 4-source dedupe
 *   - confidence ceiling 0.95 (full 4-source)
 *   - confidence degradation 0.50 (empty deep research)
 */

import { describe, expect, it } from 'bun:test'
import { AnthropicClient, type IcpShape } from '@spleed/integrations/anthropic'
import { ApifyClient } from '@spleed/integrations/apify'
import { VercelBrowserClient } from '@spleed/integrations/vercel-browser'
import {
  DeepResearchAgent,
  buildDeepResearchUserPrompt,
} from '../agents/deep-research'
import { synthesizeFinalDossier } from '../agents/profiler'
import type {
  LeadShape,
  SynthesisSourceInput,
  SynthesizedDossier,
} from '../agents/profiler/types'

// ─── Fixtures ─────────────────────────────────────────────────────────

const SAAS_ICP: IcpShape = {
  name: 'B2B SaaS founders',
  definitionNaturalLanguage: 'Technical founders of B2B SaaS startups in the US.',
  parsedFilters: { industries: ['saas'], titles: ['Founder', 'CEO'] },
}

const LENDER_ICP: IcpShape = {
  name: 'Commercial lending / factoring',
  definitionNaturalLanguage: 'Factoring lenders and commercial finance principals.',
  parsedFilters: { industries: ['fintech'] },
}

const SARAH: LeadShape = {
  fullName: 'Sarah Chen',
  firstName: 'Sarah',
  lastName: 'Chen',
  company: 'Pulse Analytics',
  role: 'Founder & CEO',
  companyDomain: 'pulseanalytics.io',
  linkedinUrl: 'https://linkedin.com/in/sarahchen',
}

const JORGE: LeadShape = {
  fullName: 'Jorge Martinez',
  firstName: 'Jorge',
  lastName: 'Martinez',
  company: 'Example Lender',
  role: 'CEO',
  companyDomain: 'examplelender.com',
  linkedinUrl: 'https://linkedin.com/in/example-ceo',
}

const HENRY: LeadShape = {
  fullName: 'Henry Wallace',
  firstName: 'Henry',
  lastName: 'Wallace',
  company: 'Wallace Steel Co.',
  role: 'Plant Manager',
  companyDomain: 'wallacesteel.com',
  linkedinUrl: 'https://linkedin.com/in/henrywallace',
}

function makeAgent(): DeepResearchAgent {
  return new DeepResearchAgent({
    anthropicClient: new AnthropicClient({ apiKey: 'mock' }),
    apifyClient: new ApifyClient(),
    vercelBrowserClient: new VercelBrowserClient(),
  })
}

/** Minimal Phase 6 synthesis used as deep-research input + final-synthesis floor. */
function makeInitialSynthesis(confidenceScore: number): SynthesizedDossier {
  return {
    hookCandidates: [
      {
        hookId: 'init-1',
        hook: 'Pulse just closed $14M Series A with Costanoa',
        evidence: '[news] TechCrunch July 2025: Pulse Analytics raises $14M Series A',
        sourceName: 'news',
        confidence: 0.9,
      },
    ],
    recommendedAngle: 'Lead with the TechCrunch Series A coverage.',
    painInferred: 'Sarah just raised Series A and is building GTM.',
    confidenceScore,
    tokensIn: 2200,
    tokensOut: 600,
    costUsd: 0.0156,
    latencyMs: 2200,
  }
}

// ─── 1. DeepResearchAgent happy path ──────────────────────────────────

describe('DeepResearchAgent — happy path', () => {
  it('Sarah Chen → 4 categories populated + Brian CSO succession + cost', async () => {
    const agent = makeAgent()
    const output = await agent.research({
      lead: SARAH,
      icp: SAAS_ICP,
      guidance: null,
      initialSynthesis: makeInitialSynthesis(0.68),
    })

    expect(output.succession_signals.findings.length).toBeGreaterThan(0)
    expect(output.hiring_signals.findings.length).toBeGreaterThan(0)
    expect(output.tech_stack_signals.findings.length).toBeGreaterThan(0)
    expect(output.recent_activity_signals.findings.length).toBeGreaterThan(0)

    // Cross-source coherence: Brian Chen CSO succession ties to the Series A.
    const brian = output.succession_signals.findings.find((f) =>
      f.signal.toLowerCase().includes('brian'),
    )
    expect(brian).toBeDefined()
    expect(brian?.confidence).toBeGreaterThan(0.9)

    // recommended_hooks integrate Phase 6 + deep research (Series A reference).
    const seriesAHook = output.recommended_hooks.find((h) =>
      h.evidence.toLowerCase().includes('series a'),
    )
    expect(seriesAHook).toBeDefined()
    expect(seriesAHook?.sourceName).toBe('deep_research')

    // Cost ≈ $0.42 LLM + $0.184 tools = ~$0.60 session.
    const toolCost =
      output.toolCalls.webSearchCount * 0.01 +
      output.toolCalls.webFetchCount * 0.001 +
      output.toolCalls.customToolCalls.reduce((s, t) => s + t.costUsd, 0)
    expect(output.llmCostUsd).toBeCloseTo(0.42, 2)
    expect(output.llmCostUsd + toolCost).toBeGreaterThan(0.5)
    expect(output.llmCostUsd + toolCost).toBeLessThan(0.7)
  })
})

// ─── 2-3. ICP guidance injection ──────────────────────────────────────

describe('Deep research — ICP guidance injection', () => {
  it('guidance provided → user prompt contains the guidance text verbatim', () => {
    const guidance = 'Prioritize SEC EDGAR, UCC filings, and state factoring registries.'
    const prompt = buildDeepResearchUserPrompt({
      lead: JORGE,
      icp: LENDER_ICP,
      guidance,
      initialSynthesis: makeInitialSynthesis(0.4),
    })
    expect(prompt).toContain('TENANT-PROVIDED RESEARCH GUIDANCE:')
    expect(prompt).toContain(guidance)
  })

  it('guidance null → user prompt uses the universal-core-4 default line', () => {
    const prompt = buildDeepResearchUserPrompt({
      lead: SARAH,
      icp: SAAS_ICP,
      guidance: null,
      initialSynthesis: makeInitialSynthesis(0.68),
    })
    expect(prompt).toContain('No additional guidance provided. Apply universal core 4')
  })
})

// ─── 4. Industry-aware emphasis (Mariana / commercial lending) ────────

describe('Deep research — industry-aware emphasis via guidance', () => {
  it('Jorge / examplelender → SEC EDGAR succession + state RFP tech_stack + gov-heavy tool count', async () => {
    const agent = makeAgent()
    const output = await agent.research({
      lead: JORGE,
      icp: LENDER_ICP,
      guidance: 'Prioritize SEC EDGAR, UCC filings, state factoring registries.',
      initialSynthesis: makeInitialSynthesis(0.4),
    })

    // Succession sourced from SEC EDGAR 10-K.
    const edgar = output.succession_signals.findings.find((f) =>
      f.evidence.toLowerCase().includes('edgar') || f.evidence.toLowerCase().includes('10-k'),
    )
    expect(edgar).toBeDefined()

    // Tech stack references the state procurement RFP.
    const rfp = output.tech_stack_signals.findings.find((f) =>
      f.signal.toLowerCase().includes('rfp') || f.evidence.toLowerCase().includes('procurement'),
    )
    expect(rfp).toBeDefined()

    // Gov-heavy research → 12 web searches (highest intensity fixture).
    expect(output.toolCalls.webSearchCount).toBe(12)
  })
})

// ─── 5-7. synthesizeFinalDossier ──────────────────────────────────────

describe('synthesizeFinalDossier — 4-source consolidation', () => {
  it('Sarah 3 initial + deep research → dedupes Series A, confidence reaches 0.95', async () => {
    const anthropic = new AnthropicClient({ apiKey: 'mock' })
    const agent = makeAgent()
    const initialSynthesis = makeInitialSynthesis(0.68)
    const deepResearchOutput = await agent.research({
      lead: SARAH,
      icp: SAAS_ICP,
      guidance: null,
      initialSynthesis,
    })

    const sources: SynthesisSourceInput[] = [
      { sourceName: 'company_website', signals: emptySignals() },
      { sourceName: 'linkedin', signals: emptySignals() },
      { sourceName: 'news', signals: emptySignals() },
    ]

    const final = await synthesizeFinalDossier({
      sources,
      deepResearchOutput,
      initialSynthesis,
      lead: SARAH,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })

    // 3 initial sources + deep research findings → 0.95 ceiling.
    expect(final.confidenceScore).toBe(0.95)
    // Hooks carry fresh uuids + deep_research attribution survives.
    expect(final.hookCandidates.length).toBeGreaterThan(0)
    expect(final.hookCandidates.some((h) => h.sourceName === 'deep_research')).toBe(true)
    for (const h of final.hookCandidates) {
      expect(h.hookId).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('confidence ceiling 0.95 holds for full 4-source Sarah coverage', async () => {
    const anthropic = new AnthropicClient({ apiKey: 'mock' })
    const agent = makeAgent()
    const initialSynthesis = makeInitialSynthesis(0.7)
    const deepResearchOutput = await agent.research({
      lead: SARAH,
      icp: SAAS_ICP,
      guidance: null,
      initialSynthesis,
    })
    const final = await synthesizeFinalDossier({
      sources: [
        { sourceName: 'company_website', signals: emptySignals() },
        { sourceName: 'linkedin', signals: emptySignals() },
        { sourceName: 'news', signals: emptySignals() },
      ],
      deepResearchOutput,
      initialSynthesis,
      lead: SARAH,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })
    expect(final.confidenceScore).toBeLessThanOrEqual(0.95)
    expect(final.confidenceScore).toBe(0.95)
  })

  it('Wallace empty deep research → final confidence stays capped ~0.50 despite 4 nominal sources', async () => {
    const anthropic = new AnthropicClient({ apiKey: 'mock' })
    const agent = makeAgent()
    const initialSynthesis = makeInitialSynthesis(0.45)
    const deepResearchOutput = await agent.research({
      lead: HENRY,
      icp: SAAS_ICP,
      guidance: null,
      initialSynthesis,
    })

    // Wallace deep research returns empty categories.
    expect(deepResearchOutput.succession_signals.findings.length).toBe(0)
    expect(deepResearchOutput.recommended_hooks.length).toBe(0)

    const final = await synthesizeFinalDossier({
      sources: [
        { sourceName: 'company_website', signals: emptySignals() },
        { sourceName: 'linkedin', signals: emptySignals() },
        { sourceName: 'news', signals: emptySignals() },
      ],
      deepResearchOutput,
      initialSynthesis,
      lead: HENRY,
      icp: SAAS_ICP,
      anthropicClient: anthropic,
    })

    // No lift from empty research — confidence stays ≤ 0.50.
    expect(final.confidenceScore).toBeLessThanOrEqual(0.5)
    expect(final.confidenceScore).toBeGreaterThanOrEqual(0.45)
  })
})

// ─── Helper ───────────────────────────────────────────────────────────

function emptySignals() {
  return {
    company_stage: 'unknown' as const,
    recent_news: [],
    pain_signals: [],
    hiring_signals: [],
    growth_signals: [],
    hook_candidates: [],
  }
}
