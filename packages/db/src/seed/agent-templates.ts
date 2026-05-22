import type { InferInsertModel } from 'drizzle-orm'
import { agentTemplates } from '../schema'
import { PROFILER_SYSTEM_PROMPT } from './prompts'

export type AgentTemplateInsert = InferInsertModel<typeof agentTemplates>

const STUB_PROMPT =
  '# TODO\n\nReal prompt content lands in Sprint 5+ from /docs/agents/agent-prompts.md.\n'

export const seedAgentTemplates: AgentTemplateInsert[] = [
  {
    kind: 'scout',
    version: '0.1',
    defaultPrompt: STUB_PROMPT,
    defaultConfig: { maxLeadsPerRun: 50, fitScoreThreshold: 0.5 },
    defaultModel: 'claude-haiku-4-5',
    description: 'Lead discovery — finds decision makers matching ICP across channels.',
  },
  {
    // Sprint 6a — Profiler activated with real prompt + per-source config.
    // Sources structure replaces the legacy tier1/2/3 toggles; only
    // companyWebsite is enabled in Sprint 6a (LinkedIn + Google News land
    // in Sprint 6b per the 8 decisions consolidated 2026-05-22).
    kind: 'profiler',
    version: '0.1',
    defaultPrompt: PROFILER_SYSTEM_PROMPT,
    defaultConfig: {
      sources: {
        companyWebsite: {
          enabled: true,
          weight: 0.3,
          provider: 'vercel-browser',
        },
        linkedinProfile: {
          enabled: false, // Sprint 6b enables
          weight: 0.4,
          provider: 'apify',
        },
        googleNews: {
          enabled: false, // Sprint 6b enables
          weight: 0.3,
          provider: 'vercel-browser',
        },
      },
      llm: {
        extractionModel: 'claude-sonnet-4-6',
        synthesisModel: 'claude-sonnet-4-6', // Sprint 6b structured pipeline uses
        maxTokensPerExtraction: 1500,
      },
      screenshots: {
        enabled: false, // Sprint 6b enables (annotated hook moments)
        confidenceThreshold: 0.7,
      },
      budgetWarnThresholdUsd: 1000,
    },
    defaultModel: 'claude-sonnet-4-6',
    description: 'Cross-channel enrichment — builds the lead dossier with screenshot evidence.',
  },
  {
    kind: 'composer',
    version: '0.1',
    defaultPrompt: STUB_PROMPT,
    defaultConfig: { defaultAssetKind: 'microsite', minDossierConfidence: 0.7 },
    defaultModel: 'claude-sonnet-4-6',
    description: 'Personalized asset composer — microsites, audits, ROI calculators.',
  },
  {
    kind: 'outreach',
    version: '0.1',
    defaultPrompt: STUB_PROMPT,
    defaultConfig: { defaultApprovalLevel: 'approve', maxFollowups: 3, breakupAfterDays: 14 },
    defaultModel: 'claude-sonnet-4-6',
    description: 'Outreach Operator — initial messages and multi-channel follow-up sequences.',
  },
  {
    kind: 'gifter',
    version: '0.1',
    defaultPrompt: STUB_PROMPT,
    defaultConfig: { preMeetingPreferred: true, maxGiftCents: 7500 },
    defaultModel: 'claude-sonnet-4-6',
    description: 'Strategic gifter — proposes timing and product, executes via Stripe Issuing.',
  },
  {
    kind: 'concierge',
    version: '0.1',
    defaultPrompt: STUB_PROMPT,
    defaultConfig: { contextWindowMessages: 200, p2DigestEnabled: true },
    defaultModel: 'claude-sonnet-4-6',
    description: 'iMessage layer — bidirectional conversational interface with P0/P1/P2 gating.',
  },
]
