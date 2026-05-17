import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { z } from 'zod'
import {
  closeServiceClient,
  getServiceClient,
  orgMembers,
  orgs,
  toolCallLogs,
  users,
} from '@spleed/db'
import { sql } from 'drizzle-orm'
import { defineTool, helloWorldTool, type ToolContext } from '../tools'
import { TaggedAgentError } from '../runtime'

const TEST_ORG_ID = '99999999-9999-9999-9999-999999999111'
const TEST_USER_ID = '99999999-9999-9999-9999-999999999222'
const TEST_USER_AUTH_ID = '99999999-9999-9999-9999-999999999333'

const logger = pino({ level: 'silent' })
const baseCtx: ToolContext = {
  orgId: TEST_ORG_ID,
  agentKind: 'scout',
  logger,
}

async function resetToolCallLogs(): Promise<void> {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await db.insert(orgs).values({ id: TEST_ORG_ID, name: 'Tool Test Org', slug: 'tool-test-org' })
  await db.insert(users).values({
    id: TEST_USER_ID,
    supabaseAuthId: TEST_USER_AUTH_ID,
    email: 'tools@test.spleed.ai',
    name: 'Tools Test',
  })
  await db.insert(orgMembers).values({ orgId: TEST_ORG_ID, userId: TEST_USER_ID, role: 'owner' })
}

beforeAll(async () => {
  await resetToolCallLogs()
})

afterAll(async () => {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await closeServiceClient()
})

describe('defineTool — input validation', () => {
  it('throws TOOL_INPUT_INVALID for malformed input', async () => {
    let caught: TaggedAgentError | null = null
    try {
      // helloWorldTool expects { message: string }; pass wrong shape
      await helloWorldTool.execute({ wrongField: 123 } as unknown as { message: string }, baseCtx)
    } catch (err) {
      caught = err as TaggedAgentError
    }
    expect(caught).not.toBeNull()
    expect(caught?.tag.startsWith('TOOL_INPUT_INVALID')).toBe(true)
  })

  it('logs a failure row to tool_call_logs on validation error', async () => {
    const db = getServiceClient()
    const before = await db.select().from(toolCallLogs).where(eq(toolCallLogs.orgId, TEST_ORG_ID))
    try {
      await helloWorldTool.execute({ message: '' } as { message: string }, baseCtx) // min(1) violation
    } catch {
      // expected
    }
    const after = await db.select().from(toolCallLogs).where(eq(toolCallLogs.orgId, TEST_ORG_ID))
    expect(after.length).toBe(before.length + 1)
    const newRow = after.find((r) => !before.find((b) => b.id === r.id))
    expect(newRow?.success).toBe(false)
    expect(newRow?.errorTag?.startsWith('TOOL_INPUT_INVALID')).toBe(true)
  })
})

describe('defineTool — success path', () => {
  it('hello_world tool returns the expected echo + persists success log', async () => {
    const before = Date.now()
    const result = await helloWorldTool.execute({ message: 'spleed test' }, baseCtx)
    expect(result.echo).toBe('scout says: spleed test')
    const tsCheck = new Date(result.at).getTime()
    expect(tsCheck).toBeGreaterThanOrEqual(before - 1000)

    const db = getServiceClient()
    const rows = await db
      .select()
      .from(toolCallLogs)
      .where(eq(toolCallLogs.orgId, TEST_ORG_ID))
    const successRows = rows.filter((r) => r.success)
    expect(successRows.length).toBeGreaterThan(0)
    const newest = successRows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
    expect(newest?.toolName).toBe('hello_world')
    expect(newest?.durationMs).not.toBeNull()
  })

  it('TaggedAgentError thrown by execute is re-thrown and logged with errorTag', async () => {
    const breakingTool = defineTool({
      name: 'breaking_test_tool',
      description: 'Always throws.',
      input: z.object({ noop: z.boolean() }),
      output: z.object({ never: z.literal(true) }),
      execute: async () => {
        throw new TaggedAgentError('BREAKING_TEST', 'always throws', { classification: 'transient' })
      },
    })

    let caught: TaggedAgentError | null = null
    try {
      await breakingTool.execute({ noop: true }, baseCtx)
    } catch (err) {
      caught = err as TaggedAgentError
    }
    expect(caught?.tag).toBe('BREAKING_TEST')

    const db = getServiceClient()
    const failureRows = await db
      .select()
      .from(toolCallLogs)
      .where(eq(toolCallLogs.orgId, TEST_ORG_ID))
    const breakingLog = failureRows.find((r) => r.toolName === 'breaking_test_tool')
    expect(breakingLog).toBeDefined()
    expect(breakingLog?.success).toBe(false)
    expect(breakingLog?.errorTag).toBe('BREAKING_TEST')
  })
})
