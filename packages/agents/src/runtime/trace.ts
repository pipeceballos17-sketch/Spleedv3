import { auditLogs, getServiceClient, toolCallLogs } from '@spleed/db'

type AgentKind = 'scout' | 'profiler' | 'composer' | 'outreach' | 'gifter' | 'concierge'

export interface PersistAuditLogInput {
  orgId: string
  userId?: string | null
  action: string
  entityType: string
  entityId?: string | null
  payload?: Record<string, unknown>
}

/**
 * Insert a row into `audit_logs` via service role. Workers + agent runtime
 * call this at every meaningful state transition (run start, complete, fail,
 * tool invocation summary, etc.).
 */
export async function persistAuditLog(input: PersistAuditLogInput): Promise<void> {
  const db = getServiceClient()
  await db.insert(auditLogs).values({
    orgId: input.orgId,
    userId: input.userId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    payload: input.payload ?? {},
  })
}

export interface PersistToolCallLogInput {
  orgId: string
  agentKind: AgentKind
  leadId?: string | null
  toolName: string
  inputJson: Record<string, unknown>
  outputJson?: Record<string, unknown> | null
  success: boolean
  errorMessage?: string | null
  errorTag?: string | null
  durationMs?: number | null
  costCents?: number | null
}

/**
 * Insert a row into `tool_call_logs`. defineTool's audit wrapper calls this
 * after every tool execute() invocation (success or failure).
 */
export async function persistToolCallLog(input: PersistToolCallLogInput): Promise<void> {
  const db = getServiceClient()
  await db.insert(toolCallLogs).values({
    orgId: input.orgId,
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
}
