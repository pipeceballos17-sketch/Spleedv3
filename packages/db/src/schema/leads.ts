import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgs } from './tenant'
import { scoutRuns } from './scout'
import { leadStatusEnum, leadThreadRoleEnum } from './enums'

/**
 * Ideal Customer Profile. Founder writes definition in natural language; an LLM
 * parser populates parsed_filters with a structured shape consumed by Scout
 * (Apollo/Apify queries), Profiler (tone match), and Gifter (product fit).
 *
 * Dual timestamps support a dirty-flag re-parsing pattern:
 *   - natural_language_updated_at advances when the founder edits the text
 *   - parsed_filters_updated_at advances when the LLM re-parses
 *   - If natural_language_updated_at > parsed_filters_updated_at, a re-parse is pending
 * The actual parser lands in Sprint 6 (BACKLOG-001 expands the shape with
 * icp_type and channel_priorities). For Sprint 2, parsed_filters can be set
 * manually via seed/import or left as just `{version:"1"}`.
 *
 * Soft delete: NOT applied — archiving is via is_active=false. Hard delete only
 * if the org is deleted (cascade).
 */
export const icps = pgTable(
  'icps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    definitionNaturalLanguage: text('definition_natural_language').notNull(),

    // version field allows the parser shape to evolve in Sprint 6+ without
    // breaking older rows. Agents check version and migrate on read if needed.
    parsedFilters: jsonb('parsed_filters').$type<{
      version: '1'
      titles?: string[]
      industries?: string[]
      companySizeMin?: number
      companySizeMax?: number
      geos?: string[]
      // Sprint 5a — seniorities consumed by Scout's SQL fit_score and
      // parseICPToApolloFilters. TS-only addition (jsonb evolves freely).
      seniorities?: string[]
      fundingStages?: string[]
      techStack?: string[]
      buyingSignals?: string[]
    }>().notNull().default(sql`'{"version":"1"}'::jsonb`),

    isActive: boolean('is_active').notNull().default(true),

    naturalLanguageUpdatedAt: timestamp('natural_language_updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    parsedFiltersUpdatedAt: timestamp('parsed_filters_updated_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgActiveIdx: index('icps_org_active_idx').on(t.orgId, t.isActive),
  }),
)

/**
 * Lead — one prospect's journey through the kanban.
 *
 * Status transitions (informational, enforced at application layer; the SQL
 * COMMENT ON TYPE lead_status in 05-policies.sql carries the same documentation):
 *   discovered → enriching → enriched → composing → composed → engaged
 *   engaged → tracking ↔ tracking_paused_human ↔ booked
 *   tracking → gift_pending → tracking (gift cycle)
 *   any state → lost (founder mark or auto-breakup)
 *
 * Soft delete: deleted_at nullable. Hot-path indexes are partial WHERE deleted_at IS NULL
 * so active-row queries stay fast as the soft-deleted set grows. Dedup uniqueness
 * is also scoped to active rows, allowing re-add of a soft-deleted lead with the
 * same email or LinkedIn URL.
 *
 * When a lead is soft-deleted, its lead_dossier should also be soft-deleted by
 * the application (no DB trigger; documented in delete-strategy.md).
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

    // Channels — fixed columns (Decision d). Adding a new channel (e.g. bluesky)
    // is an explicit migration; we deliberately avoid jsonb-creep here.
    email: text('email'),
    linkedinUrl: text('linkedin_url'),
    xHandle: text('x_handle'),
    githubHandle: text('github_handle'),

    // Shipping address (Gifter, Sprint 5+)
    officeAddress: jsonb('office_address').$type<{
      street?: string
      city?: string
      state?: string
      postal_code?: string
      country?: string
      verified?: boolean
    }>(),

    // Discovery metadata (Scout)
    foundVia: text('found_via').notNull(),
    // FK to scout_runs — populated when lead originated from a Scout run.
    // ON DELETE SET NULL so soft-deleting a run doesn't cascade-delete leads.
    // Manual ingest (BACKLOG-018) and other founder-added leads leave this NULL.
    // Circular import (scout.ts imports icps from this file) is fine —
    // drizzle's references callback is lazy and only invoked at schema graph build time.
    runId: uuid('run_id').references(() => scoutRuns.id, { onDelete: 'set null' }),
    fitScore: real('fit_score').default(0),
    fitReasoning: text('fit_reasoning'),
    // Tracks when fit_score was last computed. Sprint 5+ uses this to detect
    // staleness when Profiler enrichment refreshes dossier signals.
    fitScoreComputedAt: timestamp('fit_score_computed_at', { withTimezone: true }),
    rawSignals: jsonb('raw_signals').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),

    // Lifecycle timestamps (denormalized for fast kanban + analytics)
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    firstOutreachAt: timestamp('first_outreach_at', { withTimezone: true }),
    bookedAt: timestamp('booked_at', { withTimezone: true }),
    lostAt: timestamp('lost_at', { withTimezone: true }),
    lostReason: text('lost_reason'),

    // Soft delete (Decision f). NULL = active, non-NULL = soft-deleted.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Hot path for kanban: filter active leads by org + status
    orgStatusActiveIdx: index('leads_org_status_idx')
      .on(t.orgId, t.status)
      .where(sql`deleted_at IS NULL`),
    // Dedup uniqueness scoped to active rows — allows re-add after soft delete
    orgEmailActiveIdx: uniqueIndex('leads_org_email_active_unique')
      .on(t.orgId, t.email)
      .where(sql`deleted_at IS NULL AND email IS NOT NULL`),
    orgLinkedinActiveIdx: uniqueIndex('leads_org_linkedin_active_unique')
      .on(t.orgId, t.linkedinUrl)
      .where(sql`deleted_at IS NULL AND linkedin_url IS NOT NULL`),
  }),
)

/**
 * Cross-channel dossier built by Profiler. One per lead (PK = lead_id).
 * Soft delete to preserve enrichment history when lead is soft-deleted.
 */
export const leadDossiers = pgTable(
  'lead_dossiers',
  {
    leadId: uuid('lead_id').primaryKey().references(() => leads.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),

    pains: jsonb('pains').$type<Array<{
      description: string
      sourceUrl: string
      sourceQuote: string
      confidence: number
      recencyDaysAgo: number
    }>>().notNull().default(sql`'[]'::jsonb`),

    interests: jsonb('interests').$type<Array<{
      topic: string
      sourceUrl: string
      confidence: number
      signalStrength: 'weak' | 'medium' | 'strong'
    }>>().notNull().default(sql`'[]'::jsonb`),

    giftSignals: jsonb('gift_signals').$type<Array<{
      type: string
      description: string
      sourceUrl: string
      confidence: number
      freshnessDays: number
      suggestedGiftCategories: string[]
    }>>().notNull().default(sql`'[]'::jsonb`),

    recentChanges: jsonb('recent_changes').$type<Array<{
      kind: string
      description: string
      sourceUrl: string
      occurredAt: string
    }>>().notNull().default(sql`'[]'::jsonb`),

    preferredChannel: text('preferred_channel'),
    toneMatch: jsonb('tone_match').$type<{
      formality: 'casual' | 'professional' | 'technical'
      humor: boolean
      lengthPreference: 'short' | 'medium' | 'long'
      hotButtons: string[]
      coldButtons: string[]
    }>(),

    rawSignals: jsonb('raw_signals').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),

    confidenceScore: real('confidence_score').default(0),
    isStale: boolean('is_stale').notNull().default(false),
    enrichedBy: text('enriched_by'),

    // Soft delete — mirrors leads.deleted_at; app sets both on lead soft-delete.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
)

/**
 * Append-only thread per lead. Every agent run, tool call, system event, and
 * human note. The "shared CRUD between human and agent" pattern from Houston.
 *
 * No soft delete — append-only. GDPR scrub job hard-deletes if needed,
 * logged in audit_logs.
 *
 * RLS allows member SELECT + member INSERT only; no UPDATE/DELETE policies.
 */
export const leadThreads = pgTable(
  'lead_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    role: leadThreadRoleEnum('role').notNull(),
    agentKind: text('agent_kind'),
    content: text('content').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadCreatedIdx: index('lead_threads_lead_created_idx').on(t.leadId, t.createdAt),
  }),
)
