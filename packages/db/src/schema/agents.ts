import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
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
