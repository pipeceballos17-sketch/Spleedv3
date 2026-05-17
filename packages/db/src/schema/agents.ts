import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgs } from './tenant'
import { agentKindEnum } from './enums'

/**
 * Default agent definitions — system-wide reference data, seeded once.
 * Sprint 1 seeds these as stubs. Sprint 5+ replaces default_prompt with real prompts
 * from /docs/agents/agent-prompts.md.
 */
export const agentTemplates = pgTable(
  'agent_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: agentKindEnum('kind').notNull(),
    version: text('version').notNull().default('0.1'),
    defaultPrompt: text('default_prompt').notNull(),
    defaultConfig: jsonb('default_config').$type<Record<string, unknown>>().notNull(),
    defaultModel: text('default_model').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindVersionIdx: uniqueIndex('agent_templates_kind_version_unique').on(t.kind, t.version),
  }),
)

/**
 * Per-org agent customizations. Inherits from agent_templates.
 * Founder can override prompt, config, or disable an agent entirely.
 */
export const orgAgents = pgTable(
  'org_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').notNull().references(() => agentTemplates.id),
    kind: agentKindEnum('kind').notNull(),

    customPrompt: text('custom_prompt'),
    customConfig: jsonb('custom_config').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgKindIdx: uniqueIndex('org_agents_org_kind_unique').on(t.orgId, t.kind),
  }),
)

/**
 * Tool call audit log. Every invocation of a registered tool by an agent gets
 * a row here for debug, cost tracking, and rate-limit visibility.
 * Writes come from service role only (via defineTool's audit wrapper); members
 * can SELECT their own org's logs.
 */
export const toolCallLogs = pgTable(
  'tool_call_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    agentKind: agentKindEnum('agent_kind').notNull(),
    leadId: uuid('lead_id'),
    toolName: text('tool_name').notNull(),
    inputJson: jsonb('input_json').$type<Record<string, unknown>>().notNull(),
    outputJson: jsonb('output_json').$type<Record<string, unknown>>(),
    success: boolean('success').notNull(),
    errorMessage: text('error_message'),
    errorTag: text('error_tag'),
    durationMs: integer('duration_ms'),
    costCents: integer('cost_cents'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgRecentIdx: index('tool_call_logs_org_recent_idx').on(t.orgId, t.createdAt),
    leadIdx: index('tool_call_logs_lead_idx').on(t.leadId),
    toolNameIdx: index('tool_call_logs_tool_name_idx').on(t.toolName, t.createdAt),
  }),
)
