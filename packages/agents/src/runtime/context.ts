import type { Logger } from 'pino'
import type { AnthropicModelId } from './anthropic'

type AgentKind = 'scout' | 'profiler' | 'composer' | 'outreach' | 'gifter' | 'concierge'

/**
 * Per-run context handed to the agent runtime. Sprint 3 stub: the real
 * `buildAgentContext` lands in Sprint 5+ where it loads org_agents prompt
 * overrides, resolves template variables ({{org.name}}, {{founder.name}},
 * etc.), and pulls lead state from the DB.
 */
export interface AgentContext {
  orgId: string
  leadId?: string
  agentKind: AgentKind
  model: AnthropicModelId
  systemPrompt: string
  maxTokens: number
  logger: Logger
  traceId: string
}

export interface BuildAgentContextStubInput {
  orgId: string
  leadId?: string
  agentKind: AgentKind
  systemPrompt: string
  model: AnthropicModelId
  logger: Logger
  traceId: string
  maxTokens?: number
}

/**
 * Sprint 3 stub builder. Sprint 5+ replaces this with the real version that
 * loads from org_agents + agent_templates and resolves template variables.
 */
export function buildAgentContextStub(input: BuildAgentContextStubInput): AgentContext {
  return {
    orgId: input.orgId,
    leadId: input.leadId,
    agentKind: input.agentKind,
    model: input.model,
    systemPrompt: input.systemPrompt,
    maxTokens: input.maxTokens ?? Number(process.env.AGENT_DEFAULT_MAX_TOKENS ?? 4096),
    logger: input.logger,
    traceId: input.traceId,
  }
}
