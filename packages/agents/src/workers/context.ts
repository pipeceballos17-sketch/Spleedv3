import { and, eq } from 'drizzle-orm'
import type { Logger } from 'pino'
import {
  auditLogs,
  getServiceClient,
  leads as leadsTable,
  toolCallLogs as toolCallLogsTable,
  type DbClient,
} from '@spleed/db'

type AgentKind = 'scout' | 'profiler' | 'composer' | 'outreach' | 'gifter' | 'concierge'

/**
 * Org-scoped DB wrapper. Workers receive this instead of the raw service-role
 * Drizzle client. Methods exposed here auto-filter by orgId so workers cannot
 * accidentally read or write cross-tenant data even though the underlying
 * connection bypasses RLS.
 *
 * Escape hatch: `raw` exposes the unscoped client for queries that genuinely
 * need cross-org access (admin scripts, GDPR scrub, etc.). Workers must avoid
 * `raw` for org-scoped tables.
 */
export interface ScopedDb {
  readonly orgId: string
  readonly raw: DbClient

  readonly leads: {
    findById: (id: string) => Promise<typeof leadsTable.$inferSelect | undefined>
    findAllActive: () => Promise<Array<typeof leadsTable.$inferSelect>>
  }

  readonly auditLogs: {
    insert: (input: {
      action: string
      entityType: string
      entityId?: string | null
      userId?: string | null
      payload?: Record<string, unknown>
    }) => Promise<void>
  }

  readonly toolCallLogs: {
    insert: (input: {
      agentKind: AgentKind
      toolName: string
      inputJson: Record<string, unknown>
      outputJson?: Record<string, unknown> | null
      success: boolean
      leadId?: string | null
      errorMessage?: string | null
      errorTag?: string | null
      durationMs?: number | null
      costCents?: number | null
    }) => Promise<void>
  }
}

export function createScopedDb(orgId: string): ScopedDb {
  const raw = getServiceClient()
  return {
    orgId,
    raw,
    leads: {
      findById: async (id) => {
        const rows = await raw
          .select()
          .from(leadsTable)
          .where(and(eq(leadsTable.id, id), eq(leadsTable.orgId, orgId)))
        return rows[0]
      },
      findAllActive: async () => {
        return await raw
          .select()
          .from(leadsTable)
          .where(eq(leadsTable.orgId, orgId))
      },
    },
    auditLogs: {
      insert: async (input) => {
        await raw.insert(auditLogs).values({
          orgId,
          userId: input.userId ?? null,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          payload: input.payload ?? {},
        })
      },
    },
    toolCallLogs: {
      insert: async (input) => {
        await raw.insert(toolCallLogsTable).values({
          orgId,
          agentKind: input.agentKind,
          leadId: input.leadId ?? null,
          toolName: input.toolName,
          inputJson: input.inputJson,
          outputJson: input.outputJson ?? null,
          success: input.success,
          errorMessage: input.errorMessage ?? null,
          errorTag: input.errorTag ?? null,
          durationMs: input.durationMs ?? null,
          costCents: input.costCents ?? null,
        })
      },
    },
  }
}

/**
 * Context passed to every worker process() function. Carries the orgId
 * extracted from the validated job payload, a scoped DB client, and a logger
 * pre-bound with org_id + traceId for structured logging.
 */
export interface WorkerContext {
  orgId: string
  jobId: string
  traceId: string
  attemptsMade: number
  logger: Logger
  db: ScopedDb
}
