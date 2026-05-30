import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { planEnum, memberRoleEnum, verbosityEnum } from './enums'

/**
 * Organizations (tenants). Every operational table cascades from here.
 * slug is used in subdomains and microsite URLs.
 */
export const orgs = pgTable(
  'orgs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    plan: planEnum('plan').notNull().default('founder'),

    productDescription: text('product_description'),
    valueProps: jsonb('value_props').$type<string[]>().default(sql`'[]'::jsonb`),
    tone: text('tone').default('warm'),
    timezone: text('timezone').notNull().default('America/New_York'),

    icpDefaultLanguage: text('icp_default_language').default('en'),

    giftBudgetCapCents: integer('gift_budget_cap_cents').default(5000),
    giftBudgetUsedCents: integer('gift_budget_used_cents').default(0),
    giftApprovalThresholdCents: integer('gift_approval_threshold_cents').default(0),
    giftMerchantAllowlist: jsonb('gift_merchant_allowlist').$type<string[]>().default(
      sql`'["amazon.com","etsy.com","bluebottlecoffee.com"]'::jsonb`,
    ),
    giftExcludedCategories: jsonb('gift_excluded_categories').$type<string[]>().default(
      sql`'["alcohol","religious","political","perishable"]'::jsonb`,
    ),

    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    stripeIssuingAccountId: text('stripe_issuing_account_id'),

    // Sprint 5b — Slack Incoming Webhook URL for Scout failure / quota notifications.
    // Founder pastes this manually after creating in their Slack workspace settings.
    // Full OAuth + interactive buttons → BACKLOG-035 Sprint 9.
    slackWebhookUrl: text('slack_webhook_url'),

    // Sprint 7c — Slack OAuth-installed bot lookup columns. Coexist with
    // slackWebhookUrl above: webhook = outgoing notifications, bot OAuth =
    // bidirectional DM concierge. Real bot/user tokens live in Supabase
    // Vault keyed by `slack_oauth_{orgId}` (org_integrations.vault_secret_id);
    // these columns are the lookup index Slack event handlers use to map
    // an incoming team_id → org_id.
    slackTeamId: text('slack_team_id'),
    slackBotUserId: text('slack_bot_user_id'),
    slackConnectedAt: timestamp('slack_connected_at', { withTimezone: true }),

    // Sprint 8 — Anthropic BYOK (Decision 9). Mirrors the Slack columns above:
    // the real API key lives in Supabase Vault keyed by `anthropic_{orgId}`
    // (anthropic_vault_ref holds the secret reference); these columns are the
    // connection index/timestamp. Guided BYOK wizard + Vault wiring land in
    // Sprint 8.2; Sprint 8.1 only adds the columns.
    anthropicVaultRef: text('anthropic_vault_ref'),
    anthropicConnectedAt: timestamp('anthropic_connected_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('orgs_slug_unique').on(t.slug),
  }),
)

/**
 * Application users. supabase_auth_id links to auth.users.id (Supabase Auth).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supabaseAuthId: uuid('supabase_auth_id').notNull(),
    email: text('email').notNull(),
    name: text('name'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_unique').on(t.email),
    supabaseAuthIdx: uniqueIndex('users_supabase_auth_unique').on(t.supabaseAuthId),
  }),
)

/**
 * Membership: which user belongs to which org with what role.
 * Concierge/iMessage preferences live here per member (not per org).
 */
export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull().default('member'),

    imessagePhone: text('imessage_phone'),
    imessageVerifiedAt: timestamp('imessage_verified_at', { withTimezone: true }),
    imessageFailoverToEmail: boolean('imessage_failover_to_email').default(false),

    digestTime: text('digest_time').default('08:00'),
    quietHoursStart: text('quiet_hours_start').default('22:00'),
    quietHoursEnd: text('quiet_hours_end').default('07:00'),
    verbosity: verbosityEnum('verbosity').default('normal'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    userIdx: index('org_members_user_idx').on(t.userId),
  }),
)
