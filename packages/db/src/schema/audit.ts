import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgs, users } from './tenant'

/**
 * Application-level audit log (Decision 6).
 *
 * Written by the tRPC mutation middleware (Sprint 8/9, when tRPC arrives).
 * org_id and user_id are nullable to handle:
 *   - signup events that happen before bootstrap_user_org has run
 *   - system-wide events not tied to a specific org or user
 *
 * All inserts go through service role; RLS only allows member SELECT for
 * audit visibility within the org.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgRecentIdx: index('audit_logs_org_recent_idx').on(t.orgId, t.createdAt),
    entityIdx: index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    userRecentIdx: index('audit_logs_user_recent_idx').on(t.userId, t.createdAt),
  }),
)
