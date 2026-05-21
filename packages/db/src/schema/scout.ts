import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  boolean,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgs } from './tenant'
import { icps } from './leads'
import {
  scoutRunStatusEnum,
  scoutTriggerTypeEnum,
  agentKindEnum,
  costProviderEnum,
} from './enums'

/**
 * Scout runs — one row per Scout execution against an ICP. Captures the full
 * lifecycle (queued → running → completed/failed/partial) plus the count chain
 * (apollo_candidates_found → sql_filtered_count → leads_inserted_count) so the
 * dashboard (Sprint 9-10) can show drop-off at each phase.
 *
 * Sprint 5a: trigger_type in ('on_demand', 'manual_test'). Sprint 5b adds 'cron'
 * via BullMQ scheduler with tenant timezone (BACKLOG entry pending).
 *
 * RLS: members SELECT only. Service role (worker) INSERTs and UPDATEs.
 */
export const scoutRuns = pgTable(
  'scout_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    icpId: uuid('icp_id').notNull().references(() => icps.id, { onDelete: 'restrict' }),

    status: scoutRunStatusEnum('status').notNull().default('queued'),
    triggerType: scoutTriggerTypeEnum('trigger_type').notNull(),

    requestedVolume: integer('requested_volume').notNull().default(50),

    // Count chain — populated by worker as it progresses through phases.
    apolloCandidatesFound: integer('apollo_candidates_found'),
    sqlFilteredCount: integer('sql_filtered_count'),
    leadsInsertedCount: integer('leads_inserted_count'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),

    // Error envelope. Shape: { code, message, retry_count, last_failure_at }.
    // Sprint 5a writes baseline { code: 'UNKNOWN', message }; Sprint 5b granular.
    errorSummary: jsonb('error_summary').$type<{
      code: string
      message: string
      retry_count?: number
      last_failure_at?: string
    }>(),

    // Flex jsonb for Sprint 5b additions (e.g. llm_rerank_summary, cron_next_run).
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index('scout_runs_org_created_idx').on(t.orgId, t.createdAt.desc()),
    activeIdx: index('scout_runs_active_idx')
      .on(t.status)
      .where(sql`status IN ('queued', 'running')`),
  }),
)

/**
 * Cost events — per-call ledger across all agents. Sprint 5a writes only from
 * Scout (Apollo searches). Profiler/Composer/Outreach/Hermes/Gifter will write
 * here in their respective sprints. Dashboard aggregates per agent_type +
 * provider for cost transparency.
 *
 * `run_id` is nullable: scout writes it for traceability back to a scout_run;
 * profiler/composer (which work per-lead, not per-run) leave it NULL and
 * correlate via metadata.lead_id.
 *
 * Precision: numeric(10,6) — supports up to $9,999.99999 per call. Apollo
 * credits are ~$0.001 each; Anthropic Sonnet 4.6 input is ~$0.000003/token.
 *
 * RLS: members SELECT only. Service role (worker) INSERTs. No UPDATE/DELETE.
 */
export const costEvents = pgTable(
  'cost_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),

    // Nullable so Profiler/Composer cost events (not tied to a scout_run) work.
    runId: uuid('run_id').references(() => scoutRuns.id, { onDelete: 'set null' }),

    agentType: agentKindEnum('agent_type').notNull(),
    provider: costProviderEnum('provider').notNull(),
    operationType: text('operation_type').notNull(),

    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull(),
    latencyMs: integer('latency_ms'),

    success: boolean('success').notNull(),
    errorCode: text('error_code'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index('cost_events_org_created_idx').on(t.orgId, t.createdAt.desc()),
    runIdx: index('cost_events_run_idx')
      .on(t.runId)
      .where(sql`run_id IS NOT NULL`),
    agentProviderIdx: index('cost_events_agent_provider_idx').on(t.agentType, t.provider),
  }),
)
