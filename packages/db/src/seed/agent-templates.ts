import type { InferInsertModel } from 'drizzle-orm'
import { agentTemplates } from '../schema'

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
    kind: 'profiler',
    version: '0.1',
    defaultPrompt: STUB_PROMPT,
    defaultConfig: { tier1Always: true, tier2Always: true, tier3Conditional: true },
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
