import type Anthropic from '@anthropic-ai/sdk'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { getAnthropicClient } from './anthropic'
import type { AgentContext } from './context'
import { TaggedAgentError } from './errors'
import { withCacheControl, type CacheTTL } from './prompt-cache'
import { persistAuditLog } from './trace'
import type { Tool, ToolContext } from '../tools/define'

export interface RunAgentInput {
  ctx: AgentContext
  initialMessages: Anthropic.Messages.MessageParam[]
  tools?: Tool<unknown, unknown>[]
  cacheTtl?: CacheTTL
  /** Default false (batch). True streams events; useful when a UI consumes tokens (Sprint 9+). */
  stream?: boolean
  /** Tool-use iteration cap. Prevents runaway loops. Default 10. */
  maxIterations?: number
}

export interface RunAgentResult {
  finalMessage: string
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
  iterations: number
  stopReason: Anthropic.Messages.Message['stop_reason']
}

/**
 * Run an agent through the tool_use loop. Sprint 3 wires the loop end-to-end
 * with prompt caching, error classification, and audit logging. Sprint 5+
 * adds per-agent prompts (loaded from org_agents) and real tools (Apollo,
 * Apify, etc.) on top of this same machinery.
 */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const {
    ctx,
    initialMessages,
    tools = [],
    cacheTtl = 'ephemeral',
    stream = false,
    maxIterations = 10,
  } = input

  const client = getAnthropicClient()
  const messages: Anthropic.Messages.MessageParam[] = [...initialMessages]
  const toolCalls: RunAgentResult['toolCalls'] = []
  const usage: RunAgentResult['usage'] = { inputTokens: 0, outputTokens: 0 }
  const startTs = Date.now()

  await persistAuditLog({
    orgId: ctx.orgId,
    action: `agent.${ctx.agentKind}.start`,
    entityType: 'agent',
    payload: { traceId: ctx.traceId, leadId: ctx.leadId, stream, cacheTtl },
  })

  const anthropicTools: Anthropic.Messages.Tool[] | undefined = tools.length
    ? tools.map(toAnthropicTool)
    : undefined

  let lastResponse: Anthropic.Messages.Message | null = null

  try {
    for (let iter = 0; iter < maxIterations; iter++) {
      const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model: ctx.model,
        max_tokens: ctx.maxTokens,
        // The CachedTextBlock from withCacheControl has cache_control which the
        // Anthropic API accepts at runtime; @anthropic-ai/sdk@0.30.1's
        // TextBlockParam type doesn't expose it yet, so we cast at the boundary.
        system: [withCacheControl(ctx.systemPrompt, cacheTtl)] as Anthropic.Messages.MessageCreateParamsNonStreaming['system'],
        messages,
        tools: anthropicTools,
      }

      let response: Anthropic.Messages.Message
      if (stream) {
        const s = client.messages.stream(params)
        response = await s.finalMessage()
      } else {
        response = await client.messages.create(params)
      }
      lastResponse = response

      usage.inputTokens += response.usage.input_tokens
      usage.outputTokens += response.usage.output_tokens
      // Prompt-caching usage fields: emitted by the API at runtime but missing
      // from the @anthropic-ai/sdk@0.30.1 Usage type. Cast to read them.
      const cacheUsage = response.usage as typeof response.usage & {
        cache_read_input_tokens?: number | null
        cache_creation_input_tokens?: number | null
      }
      if (cacheUsage.cache_read_input_tokens != null) {
        usage.cacheReadTokens =
          (usage.cacheReadTokens ?? 0) + cacheUsage.cache_read_input_tokens
      }
      if (cacheUsage.cache_creation_input_tokens != null) {
        usage.cacheCreationTokens =
          (usage.cacheCreationTokens ?? 0) + cacheUsage.cache_creation_input_tokens
      }

      messages.push({ role: 'assistant', content: response.content })

      if (response.stop_reason !== 'tool_use') {
        const finalMessage = extractText(response.content)
        await persistAuditLog({
          orgId: ctx.orgId,
          action: `agent.${ctx.agentKind}.complete`,
          entityType: 'agent',
          payload: {
            traceId: ctx.traceId,
            durationMs: Date.now() - startTs,
            iterations: iter + 1,
            usage,
            stopReason: response.stop_reason,
          },
        })
        return {
          finalMessage,
          toolCalls,
          usage,
          iterations: iter + 1,
          stopReason: response.stop_reason,
        }
      }

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      )
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []

      for (const tu of toolUseBlocks) {
        const tool = tools.find((t) => t.name === tu.name)
        if (!tool) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({ error: `Tool '${tu.name}' is not registered for this agent.` }),
            is_error: true,
          })
          continue
        }
        try {
          const toolCtx: ToolContext = {
            orgId: ctx.orgId,
            leadId: ctx.leadId,
            agentKind: ctx.agentKind,
            logger: ctx.logger,
          }
          const output = await tool.execute(tu.input, toolCtx)
          toolCalls.push({ name: tu.name, input: tu.input, output })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(output),
          })
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
              tag: err instanceof TaggedAgentError ? err.tag : undefined,
            }),
            is_error: true,
          })
        }
      }

      messages.push({ role: 'user', content: toolResults })
    }

    throw new TaggedAgentError(
      'MAX_ITERATIONS_EXCEEDED',
      `Agent exceeded ${maxIterations} tool-use iterations`,
      { context: { agentKind: ctx.agentKind, traceId: ctx.traceId } },
    )
  } catch (err) {
    await persistAuditLog({
      orgId: ctx.orgId,
      action: `agent.${ctx.agentKind}.failed`,
      entityType: 'agent',
      payload: {
        traceId: ctx.traceId,
        durationMs: Date.now() - startTs,
        error: err instanceof Error ? err.message : String(err),
        errorTag: err instanceof TaggedAgentError ? err.tag : null,
        partialUsage: usage,
        lastStopReason: lastResponse?.stop_reason ?? null,
      },
    })
    throw err
  }
}

function extractText(content: Anthropic.Messages.Message['content']): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function toAnthropicTool(t: Tool<unknown, unknown>): Anthropic.Messages.Tool {
  const schema = zodToJsonSchema(t.input, { target: 'jsonSchema7' }) as Record<string, unknown>
  // Anthropic expects a JSON Schema object with type:'object'. zod-to-json-schema
  // strips the $schema and definitions wrappers we don't need; we pass the result through.
  return {
    name: t.name,
    description: t.description,
    input_schema: schema as Anthropic.Messages.Tool.InputSchema,
  }
}

export { withCacheControl, type CacheTTL } from './prompt-cache'
export { TaggedAgentError, errors, type ErrorClassification } from './errors'
export { buildAgentContextStub, type AgentContext } from './context'
export {
  getAnthropicClient,
  ANTHROPIC_MODELS,
  type AnthropicModelKey,
  type AnthropicModelId,
} from './anthropic'
export { persistAuditLog, persistToolCallLog } from './trace'
