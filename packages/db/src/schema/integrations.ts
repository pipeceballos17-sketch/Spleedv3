import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgs } from './tenant'
import { integrationKindEnum, integrationStatusEnum } from './enums'

/**
 * Per-org connections to external services (Apollo, Gmail, Sendblue, etc.).
 * Credentials encrypted at rest in Supabase Vault — we only store the secret_id reference here.
 * Sprint 5+ implements the wrapper functions that read/write Vault by secret_id.
 */
export const orgIntegrations = pgTable(
  'org_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    kind: integrationKindEnum('kind').notNull(),

    vaultSecretId: text('vault_secret_id').notNull(),

    accountIdentifier: text('account_identifier'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),

    status: integrationStatusEnum('status').notNull().default('connected'),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    lastErrorMessage: text('last_error_message'),

    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgKindIdx: uniqueIndex('org_integrations_org_kind_unique').on(t.orgId, t.kind),
  }),
)
