import type { Logger } from 'pino'
import type { z, ZodType } from 'zod'
import { TaggedAgentError } from '../runtime/errors'
import { persistToolCallLog } from '../runtime/trace'

type AgentKind = 'scout' | 'profiler' | 'composer' | 'outreach' | 'gifter' | 'concierge'

/**
 * Context passed to every tool's `execute()`. Tools receive the org_id and
 * agent_kind for scoped operations + audit logging; they should NEVER trust
 * any orgId from input — only from this context.
 */
export interface ToolContext {
  orgId: string
  leadId?: string
  agentKind: AgentKind
  logger: Logger
}

export interface Tool<TInput, TOutput> {
  name: string
  description: string
  input: ZodType<TInput>
  output?: ZodType<TOutput>
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>
}

/**
 * Wrap a tool config with input validation + tool_call_logs audit. Every tool
 * registered via this helper automatically:
 *   1. Validates input with the declared zod schema (throws on invalid).
 *   2. Logs success/failure + duration to tool_call_logs.
 *   3. Propagates TaggedAgentError so the runtime + worker can classify.
 *
 * Tools should be pure functions on their inputs + the ctx provided. They
 * MUST NOT read orgId from anywhere other than ctx.orgId.
 */
export function defineTool<TInput, TOutput>(
  config: Tool<TInput, TOutput>,
): Tool<TInput, TOutput> {
  return {
    name: config.name,
    description: config.description,
    input: config.input,
    output: config.output,
    execute: async (rawInput: TInput, ctx: ToolContext): Promise<TOutput> => {
      const parseResult = config.input.safeParse(rawInput)
      if (!parseResult.success) {
        const taggedErr = new TaggedAgentError(
          `TOOL_INPUT_INVALID:${config.name.toUpperCase()}`,
          `Tool ${config.name} received invalid input: ${parseResult.error.message}`,
          { classification: 'permanent', context: { input: rawInput, zodIssues: parseResult.error.issues } },
        )
        await persistToolCallLog({
          orgId: ctx.orgId,
          agentKind: ctx.agentKind,
          leadId: ctx.leadId,
          toolName: config.name,
          inputJson: rawInput as Record<string, unknown>,
          success: false,
          errorMessage: taggedErr.message,
          errorTag: taggedErr.tag,
          durationMs: 0,
        })
        throw taggedErr
      }
      const validated = parseResult.data
      const startTs = Date.now()
      try {
        const output = await config.execute(validated, ctx)
        await persistToolCallLog({
          orgId: ctx.orgId,
          agentKind: ctx.agentKind,
          leadId: ctx.leadId,
          toolName: config.name,
          inputJson: validated as Record<string, unknown>,
          outputJson: output as Record<string, unknown>,
          success: true,
          durationMs: Date.now() - startTs,
        })
        return output
      } catch (err) {
        await persistToolCallLog({
          orgId: ctx.orgId,
          agentKind: ctx.agentKind,
          leadId: ctx.leadId,
          toolName: config.name,
          inputJson: validated as Record<string, unknown>,
          success: false,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorTag: err instanceof TaggedAgentError ? err.tag : null,
          durationMs: Date.now() - startTs,
        })
        throw err
      }
    },
  }
}

/** Type helper: extract the input type of a Tool. */
export type ToolInput<T> = T extends Tool<infer I, unknown> ? I : never
/** Type helper: extract the output type of a Tool. */
export type ToolOutput<T> = T extends Tool<unknown, infer O> ? O : never
