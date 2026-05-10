// =====================================================================
// Spleed — Schema Drizzle + RLS Policies (Sprint 1 deliverable)
// =====================================================================
//
// Versión: 0.2 (consolida master prompt v0.1 + patch v0.2)
// Stack: Drizzle ORM + Supabase Postgres + RLS por org_id en TODA tabla operacional
//
// Estructura del paquete:
//   /packages/db/
//     schema/
//       index.ts              ← exporta todas las tablas
//       enums.ts              ← enums compartidos
//       tenant.ts             ← orgs, users, org_members
//       integrations.ts       ← org_integrations, org_browser_profiles
//       agents.ts             ← agent_templates, org_agents
//       leads.ts              ← icps, leads, lead_dossiers, lead_threads
//       outreach.ts           ← assets, outreach_events, tracking_events
//       gifting.ts            ← gifts, approval_requests
//       concierge.ts          ← concierge_threads, concierge_memory, quiet_hours_overrides
//     migrations/             ← drizzle-kit generated SQL
//     rls/
//       policies.sql          ← TODAS las RLS policies en un solo archivo
//       helpers.sql           ← funciones SQL custom (current_org_id, etc.)
//     tests/
//       isolation.test.ts     ← test crítico de aislamiento multi-tenant
//     seed/
//       agent_templates.ts    ← seed inicial de los 5 agentes + Concierge
//
// =====================================================================

// =====================================================================
// FILE: packages/db/schema/enums.ts
// =====================================================================

import { pgEnum } from 'drizzle-orm/pg-core';

export const planEnum = pgEnum('plan', ['founder', 'team', 'scale']);
export const memberRoleEnum = pgEnum('member_role', ['owner', 'member']);
export const integrationKindEnum = pgEnum('integration_kind', [
  'apollo',
  'gmail',
  'sendblue',
  'stripe_issuing',
  'cal_com',
  'resend',
  'apify',
]);
export const integrationStatusEnum = pgEnum('integration_status', [
  'connected',
  'expired',
  'error',
  'disconnected',
]);
export const agentKindEnum = pgEnum('agent_kind', [
  'scout',
  'profiler',
  'composer',
  'outreach',
  'gifter',
  'concierge',
]);
export const leadStatusEnum = pgEnum('lead_status', [
  'discovered',
  'enriching',
  'enriched',
  'composing',
  'composed',
  'engaged',
  'tracking',
  'tracking_paused_human',
  'gift_pending',
  'booked',
  'lost',
]);
export const leadThreadRoleEnum = pgEnum('lead_thread_role', [
  'agent',
  'user',
  'tool',
  'system',
]);
export const assetKindEnum = pgEnum('asset_kind', [
  'microsite',
  'demo_video',
  'audit_pdf',
  'roi_calculator',
  'loom_script',
]);
export const outreachChannelEnum = pgEnum('outreach_channel', [
  'email',
  'linkedin',
  'x',
  'imessage',
]);
export const outreachDirectionEnum = pgEnum('outreach_direction', [
  'outbound',
  'inbound',
]);
export const outreachStatusEnum = pgEnum('outreach_status', [
  'queued',
  'sent',
  'delivered',
  'opened',
  'replied',
  'bounced',
  'failed',
]);
export const trackingEventKindEnum = pgEnum('tracking_event_kind', [
  'page_view',
  'cta_click',
  'video_play',
  'calendar_open',
  'calendar_book',
]);
export const giftStatusEnum = pgEnum('gift_status', [
  'proposed',
  'pending_approval',
  'approved',
  'rejected',
  'purchasing',
  'purchased',
  'shipped',
  'delivered',
  'failed',
]);
export const approvalKindEnum = pgEnum('approval_kind', [
  'gift',
  'outreach_initial',
  'outreach_followup',
  'config_change',
  'other',
]);
export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'edited',
  'expired',
]);
export const approvalChannelEnum = pgEnum('approval_channel', [
  'imessage',
  'email',
  'web',
]);
export const conciergeDirectionEnum = pgEnum('concierge_direction', [
  'inbound',
  'outbound',
]);
export const conciergeIntentEnum = pgEnum('concierge_intent', [
  'query',
  'command',
  'approval_response',
  'clarification',
  'chitchat',
  'ambiguous',
]);
export const conciergePriorityEnum = pgEnum('concierge_priority', [
  'P0',
  'P1',
  'P2',
]);
export const verbosityEnum = pgEnum('verbosity', ['terse', 'normal', 'detailed']);
export const scrapingProviderEnum = pgEnum('scraping_provider', [
  'apify',
  'agent_browser',
]);

// =====================================================================
// FILE: packages/db/schema/tenant.ts
// =====================================================================

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
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  planEnum,
  memberRoleEnum,
  verbosityEnum,
} from './enums';

/**
 * Organizations (tenants). Every operational table cascades from here.
 * Slug is used in subdomains for microsites: lead.spleed.ai/[slug-of-lead-from-org].
 */
export const orgs = pgTable(
  'orgs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    plan: planEnum('plan').notNull().default('founder'),

    // Product context (set in onboarding, used by all agents)
    productDescription: text('product_description'),
    valueProps: jsonb('value_props').$type<string[]>().default(sql`'[]'::jsonb`),
    tone: text('tone').default('warm'), // casual | formal | contrarian | warm
    timezone: text('timezone').notNull().default('America/New_York'),

    // ICP-related defaults
    iCpDefaultLanguage: text('icp_default_language').default('en'),

    // Gifting config
    giftBudgetCapCents: integer('gift_budget_cap_cents').default(5000), // $50/mo default
    giftBudgetUsedCents: integer('gift_budget_used_cents').default(0),
    giftApprovalThresholdCents: integer('gift_approval_threshold_cents').default(0), // $0 = approve every gift
    giftMerchantAllowlist: jsonb('gift_merchant_allowlist').$type<string[]>().default(
      sql`'["amazon.com","etsy.com","bluebottlecoffee.com"]'::jsonb`,
    ),
    giftExcludedCategories: jsonb('gift_excluded_categories').$type<string[]>().default(
      sql`'["alcohol","religious","political","perishable"]'::jsonb`,
    ),

    // Stripe billing on Spleed itself
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    stripeIssuingAccountId: text('stripe_issuing_account_id'), // for issuing virtual cards

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('orgs_slug_unique').on(t.slug),
  }),
);

/**
 * Users — auth identities. One user can belong to multiple orgs (future: agencies).
 * supabase_auth_id links to Supabase Auth's auth.users.id.
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
);

/**
 * Membership: which user belongs to which org with what role.
 * Includes Concierge/iMessage settings per member.
 */
export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull().default('member'),

    // iMessage config per member (each member has own phone)
    imessagePhone: text('imessage_phone'), // E.164 format: +14155551234
    imessageVerifiedAt: timestamp('imessage_verified_at', { withTimezone: true }),
    imessageFailoverToEmail: boolean('imessage_failover_to_email').default(false),

    // Concierge preferences
    digestTime: text('digest_time').default('08:00'), // HH:mm in org timezone
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
);

/**
 * Temporary quiet hours overrides (e.g., founder at a wedding).
 * Concierge respects these in P1/P2 events.
 */
export const quietHoursOverrides = pgTable(
  'quiet_hours_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    reason: text('reason'), // human-readable: "wedding", "vacation", etc.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeIdx: index('quiet_hours_active_idx').on(t.orgId, t.userId, t.endAt),
  }),
);

// =====================================================================
// FILE: packages/db/schema/integrations.ts
// =====================================================================

import {
  integrationKindEnum,
  integrationStatusEnum,
  scrapingProviderEnum,
} from './enums';

/**
 * Per-org connections to external services (Apollo, Gmail, Sendblue, etc.).
 * Credentials encrypted at rest in Supabase Vault — we only store reference IDs here.
 */
export const orgIntegrations = pgTable(
  'org_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    kind: integrationKindEnum('kind').notNull(),

    // Reference to encrypted credentials in Supabase Vault
    vaultSecretId: text('vault_secret_id').notNull(),

    // Public metadata (non-sensitive)
    accountIdentifier: text('account_identifier'), // email, username, account ID
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
);

/**
 * Phase 2 preparation: when we migrate from Apify to agent-browser.
 * Empty in MVP, populated when org imports their LinkedIn cookies via Chrome extension.
 */
export const orgBrowserProfiles = pgTable('org_browser_profiles', {
  orgId: uuid('org_id').primaryKey().references(() => orgs.id, { onDelete: 'cascade' }),

  // Encrypted blob (AES-256-GCM, key derived from org_id + master key)
  encryptedCookies: text('encrypted_cookies'), // base64 encoded ciphertext, null in MVP

  cookiesImportedAt: timestamp('cookies_imported_at', { withTimezone: true }),
  cookiesLastValidatedAt: timestamp('cookies_last_validated_at', { withTimezone: true }),

  preferredProvider: scrapingProviderEnum('preferred_provider').notNull().default('apify'),

  // Rate limit tracking to avoid LinkedIn bans
  rateLimitWindowStart: timestamp('rate_limit_window_start', { withTimezone: true }),
  rateLimitRequestCount: integer('rate_limit_request_count').default(0),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// =====================================================================
// FILE: packages/db/schema/agents.ts
// =====================================================================

import { agentKindEnum } from './enums';

/**
 * Default agent templates — seeded once. The 5 operational agents + Concierge.
 * These are read-only references that org_agents extend.
 */
export const agentTemplates = pgTable(
  'agent_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: agentKindEnum('kind').notNull(),
    version: text('version').notNull().default('0.1'),
    defaultPrompt: text('default_prompt').notNull(), // markdown content of prompt.md
    defaultConfig: jsonb('default_config').$type<Record<string, unknown>>().notNull(),
    defaultModel: text('default_model').notNull(), // claude-sonnet-4-6 | claude-haiku-4-5
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindVersionIdx: uniqueIndex('agent_templates_kind_version_unique').on(t.kind, t.version),
  }),
);

/**
 * Per-org agent customizations. Inherits from agent_templates.
 * Founder can edit prompt, override config, disable agents.
 */
export const orgAgents = pgTable(
  'org_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').notNull().references(() => agentTemplates.id),
    kind: agentKindEnum('kind').notNull(), // denormalized for query speed

    customPrompt: text('custom_prompt'), // null = use default from template
    customConfig: jsonb('custom_config').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgKindIdx: uniqueIndex('org_agents_org_kind_unique').on(t.orgId, t.kind),
  }),
);

/**
 * Tool call audit log — every tool invocation logged for debug + rate limiting.
 */
export const toolCallLogs = pgTable(
  'tool_call_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    agentKind: agentKindEnum('agent_kind').notNull(),
    leadId: uuid('lead_id'), // nullable, not all tools are lead-scoped
    toolName: text('tool_name').notNull(),
    inputJson: jsonb('input_json').notNull(),
    outputJson: jsonb('output_json'),
    success: boolean('success').notNull(),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    costCents: integer('cost_cents'), // Apify, Apollo cost tracking
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgRecentIdx: index('tool_call_logs_org_recent_idx').on(t.orgId, t.createdAt),
    leadIdx: index('tool_call_logs_lead_idx').on(t.leadId),
  }),
);

// =====================================================================
// FILE: packages/db/schema/leads.ts
// =====================================================================

import { real } from 'drizzle-orm/pg-core';
import { leadStatusEnum, leadThreadRoleEnum } from './enums';

/**
 * Ideal Customer Profiles. An org can have multiple (different segments).
 * The natural language definition is what Scout reads as primary input.
 */
export const icps = pgTable(
  'icps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    definitionNaturalLanguage: text('definition_natural_language').notNull(),

    // Parsed filters (LLM extracts these from natural language)
    parsedFilters: jsonb('parsed_filters').$type<{
      titles?: string[];
      industries?: string[];
      companySizeMin?: number;
      companySizeMax?: number;
      geos?: string[];
      fundingStages?: string[];
      techStack?: string[];
      buyingSignals?: string[];
    }>().default(sql`'{}'::jsonb`),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgActiveIdx: index('icps_org_active_idx').on(t.orgId, t.isActive),
  }),
);

/**
 * The kanban cards. Each lead is one prospect's journey through the pipeline.
 */
export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    icpId: uuid('icp_id').references(() => icps.id),

    status: leadStatusEnum('status').notNull().default('discovered'),

    // Identity
    fullName: text('full_name').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    company: text('company').notNull(),
    role: text('role').notNull(),
    companyDomain: text('company_domain'),

    // Channels
    email: text('email'),
    linkedinUrl: text('linkedin_url'),
    xHandle: text('x_handle'),
    githubHandle: text('github_handle'),

    // Office address for shipping (used by Gifter)
    officeAddress: jsonb('office_address').$type<{
      street?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country?: string;
      verified?: boolean; // false if scraped from LinkedIn (might be stale)
    }>(),

    // Discovery metadata
    foundVia: text('found_via').notNull(), // apollo|crunchbase_funding|hiring_signal|github|google_search|manual
    fitScore: real('fit_score').default(0),
    fitReasoning: text('fit_reasoning'),
    rawSignals: jsonb('raw_signals').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),

    // Timestamps for kanban analytics
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    firstOutreachAt: timestamp('first_outreach_at', { withTimezone: true }),
    bookedAt: timestamp('booked_at', { withTimezone: true }),
    lostAt: timestamp('lost_at', { withTimezone: true }),
    lostReason: text('lost_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgStatusIdx: index('leads_org_status_idx').on(t.orgId, t.status),
    orgEmailIdx: uniqueIndex('leads_org_email_unique').on(t.orgId, t.email).where(sql`email IS NOT NULL`),
    orgLinkedinIdx: uniqueIndex('leads_org_linkedin_unique').on(t.orgId, t.linkedinUrl).where(sql`linkedin_url IS NOT NULL`),
  }),
);

/**
 * Cross-channel dossier built by Profiler. One per lead.
 * raw_signals preserves original data for downstream agents to reference.
 */
export const leadDossiers = pgTable(
  'lead_dossiers',
  {
    leadId: uuid('lead_id').primaryKey().references(() => leads.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),

    pains: jsonb('pains').$type<Array<{
      description: string;
      sourceUrl: string;
      sourceQuote: string;
      confidence: number;
      recencyDaysAgo: number;
    }>>().default(sql`'[]'::jsonb`),

    interests: jsonb('interests').$type<Array<{
      topic: string;
      sourceUrl: string;
      confidence: number;
      signalStrength: 'weak' | 'medium' | 'strong';
    }>>().default(sql`'[]'::jsonb`),

    giftSignals: jsonb('gift_signals').$type<Array<{
      type: string;
      description: string;
      sourceUrl: string;
      confidence: number;
      freshnessDays: number;
      suggestedGiftCategories: string[];
    }>>().default(sql`'[]'::jsonb`),

    recentChanges: jsonb('recent_changes').$type<Array<{
      kind: string;
      description: string;
      sourceUrl: string;
      occurredAt: string;
    }>>().default(sql`'[]'::jsonb`),

    preferredChannel: text('preferred_channel'), // linkedin | x | email
    toneMatch: jsonb('tone_match').$type<{
      formality: 'casual' | 'professional' | 'technical';
      humor: boolean;
      lengthPreference: 'short' | 'medium' | 'long';
      hotButtons: string[];
      coldButtons: string[];
    }>(),

    rawSignals: jsonb('raw_signals').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),

    confidenceScore: real('confidence_score').default(0),
    isStale: boolean('is_stale').default(false),
    enrichedBy: text('enriched_by'), // version of profiler that built this

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Persistent thread per lead. Every agent run, tool call, and human note appended.
 * This is the "shared CRUD between human and agent" pattern from Houston.
 */
export const leadThreads = pgTable(
  'lead_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    role: leadThreadRoleEnum('role').notNull(),
    agentKind: text('agent_kind'), // null if role=user
    content: text('content').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadCreatedIdx: index('lead_threads_lead_created_idx').on(t.leadId, t.createdAt),
  }),
);

// =====================================================================
// FILE: packages/db/schema/outreach.ts
// =====================================================================

import {
  assetKindEnum,
  outreachChannelEnum,
  outreachDirectionEnum,
  outreachStatusEnum,
  trackingEventKindEnum,
} from './enums';

/**
 * Generated assets (microsites, demos, audits). Public URL hosted at lead.spleed.ai/[slug].
 */
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),

    kind: assetKindEnum('kind').notNull(),
    slug: text('slug').notNull(),

    // Renderer-specific structured content
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),

    publicUrl: text('public_url').notNull(),
    ogImageUrl: text('og_image_url'),

    // Tracking
    viewCount: integer('view_count').default(0),
    uniqueViewerCount: integer('unique_viewer_count').default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),

    // Suggested outreach message Composer generated alongside the asset
    preferredOutreachMessage: text('preferred_outreach_message'),

    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('assets_slug_unique').on(t.slug),
    leadKindIdx: index('assets_lead_kind_idx').on(t.leadId, t.kind),
  }),
);

/**
 * Every outbound message sent + every inbound reply received.
 * The complete outreach history per lead.
 */
export const outreachEvents = pgTable(
  'outreach_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').references(() => assets.id),

    channel: outreachChannelEnum('channel').notNull(),
    direction: outreachDirectionEnum('direction').notNull(),

    // Content
    subject: text('subject'), // email only
    content: text('content').notNull(),

    // Provider-specific IDs for tracking (Resend message ID, LinkedIn DM ID, etc.)
    providerMessageId: text('provider_message_id'),

    // Lifecycle
    status: outreachStatusEnum('status').notNull().default('queued'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),

    // For follow-up logic
    sequencePosition: integer('sequence_position'), // 1=initial, 2=followup1, etc.

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadCreatedIdx: index('outreach_events_lead_created_idx').on(t.leadId, t.createdAt),
    statusIdx: index('outreach_events_status_idx').on(t.status),
  }),
);

/**
 * Microsite tracking: every page view, CTA click, video play, etc.
 * No PII collection — just behavioral signals.
 */
export const trackingEvents = pgTable(
  'tracking_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),

    kind: trackingEventKindEnum('kind').notNull(),

    // Anonymized session tracking
    sessionFingerprint: text('session_fingerprint'), // hashed IP+UA, no raw IP stored
    referrer: text('referrer'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    assetCreatedIdx: index('tracking_events_asset_created_idx').on(t.assetId, t.createdAt),
  }),
);

// =====================================================================
// FILE: packages/db/schema/gifting.ts
// =====================================================================

import {
  giftStatusEnum,
  approvalKindEnum,
  approvalStatusEnum,
  approvalChannelEnum,
} from './enums';

/**
 * Gift proposals from Gifter agent. Each row tracks one gift through full lifecycle.
 */
export const gifts = pgTable(
  'gifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),

    status: giftStatusEnum('status').notNull().default('proposed'),

    // Product
    productName: text('product_name').notNull(),
    productUrl: text('product_url'),
    productImageUrl: text('product_image_url'),
    merchant: text('merchant').notNull(),
    costCents: integer('cost_cents').notNull(),
    shippingCostCents: integer('shipping_cost_cents').default(0),

    // Stripe Issuing
    virtualCardId: text('virtual_card_id'), // Stripe Issuing card.id
    actualChargedCents: integer('actual_charged_cents'),

    // Shipping
    shippingAddress: jsonb('shipping_address').$type<{
      name: string;
      street: string;
      city: string;
      state: string;
      postal_code: string;
      country: string;
    }>(),
    trackingNumber: text('tracking_number'),
    trackingCarrier: text('tracking_carrier'),

    // Reasoning + message
    reasoning: text('reasoning').notNull(), // why Gifter chose this gift
    messageToLead: text('message_to_lead').notNull(), // card text or DM

    // Lifecycle timestamps
    proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    purchasedAt: timestamp('purchased_at', { withTimezone: true }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),

    failureReason: text('failure_reason'), // populated if status=failed

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadIdx: index('gifts_lead_idx').on(t.leadId),
    orgStatusIdx: index('gifts_org_status_idx').on(t.orgId, t.status),
  }),
);

/**
 * Generic approval requests. Used for gifts, sensitive outreach, config changes.
 * Concierge picks these up and orchestrates iMessage HITL.
 */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),

    kind: approvalKindEnum('kind').notNull(),

    // Polymorphic reference
    relatedLeadId: uuid('related_lead_id').references(() => leads.id),
    relatedGiftId: uuid('related_gift_id').references(() => gifts.id),

    // Full payload for Concierge to format the iMessage
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    status: approvalStatusEnum('status').notNull().default('pending'),
    sentVia: approvalChannelEnum('sent_via'),

    // Decision outcome
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
    decisionNote: text('decision_note'), // EDIT: text or rejection reason

    // Timing
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgPendingIdx: index('approval_requests_org_pending_idx').on(t.orgId, t.status),
    expiresIdx: index('approval_requests_expires_idx').on(t.expiresAt),
  }),
);

// =====================================================================
// FILE: packages/db/schema/concierge.ts
// =====================================================================

import {
  conciergeDirectionEnum,
  conciergeIntentEnum,
  conciergePriorityEnum,
} from './enums';

/**
 * Every iMessage exchange between founder and Concierge agent.
 * Last 200 messages stay in agent context; older summarized to concierge_memory.
 */
export const conciergeThreads = pgTable(
  'concierge_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

    direction: conciergeDirectionEnum('direction').notNull(),
    content: text('content').notNull(),

    // For inbound: classified intent
    intent: conciergeIntentEnum('intent'),

    // For outbound: priority that triggered this
    priority: conciergePriorityEnum('priority'),
    eventKind: text('event_kind'), // matches the event_kind from agent emission

    // Polymorphic links
    relatedLeadId: uuid('related_lead_id').references(() => leads.id),
    relatedApprovalId: uuid('related_approval_id').references(() => approvalRequests.id),
    relatedGiftId: uuid('related_gift_id').references(() => gifts.id),

    // Sendblue tracking
    sendblueMessageId: text('sendblue_message_id'),
    deliveryStatus: text('delivery_status'), // queued|sent|delivered|failed
    failoverToEmail: boolean('failover_to_email').default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgRecentIdx: index('concierge_threads_org_recent_idx').on(t.orgId, t.createdAt),
    userRecentIdx: index('concierge_threads_user_recent_idx').on(t.userId, t.createdAt),
  }),
);

/**
 * Compressed memory of older conversations. Concierge reads these as background context
 * when the immediate 200-message buffer doesn't have what it needs.
 */
export const conciergeMemory = pgTable(
  'concierge_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

    summary: text('summary').notNull(),
    coveredPeriodStart: timestamp('covered_period_start', { withTimezone: true }).notNull(),
    coveredPeriodEnd: timestamp('covered_period_end', { withTimezone: true }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgPeriodIdx: index('concierge_memory_org_period_idx').on(t.orgId, t.coveredPeriodEnd),
  }),
);

// =====================================================================
// FILE: packages/db/schema/index.ts
// =====================================================================

export * from './enums';
export * from './tenant';
export * from './integrations';
export * from './agents';
export * from './leads';
export * from './outreach';
export * from './gifting';
export * from './concierge';
