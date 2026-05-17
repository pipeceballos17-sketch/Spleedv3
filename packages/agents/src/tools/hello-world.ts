import { z } from 'zod'
import { defineTool } from './define'

/**
 * Reference tool — smoke test for the runtime + tools layer. Echoes the input
 * message with the agent kind prefixed. Sprint 5+ replaces this with the real
 * Apollo / Apify / etc. tools per /docs/agents/agent-prompts.md.
 */
export const helloWorldTool = defineTool({
  name: 'hello_world',
  description:
    'Echoes the input message prefixed with the calling agent\'s kind. Used to validate that the runtime, tool registration, and audit logging work end-to-end. Not for production use.',
  input: z.object({
    message: z.string().min(1).max(500),
  }),
  output: z.object({
    echo: z.string(),
    at: z.string(),
  }),
  execute: async ({ message }, ctx) => ({
    echo: `${ctx.agentKind} says: ${message}`,
    at: new Date().toISOString(),
  }),
})
