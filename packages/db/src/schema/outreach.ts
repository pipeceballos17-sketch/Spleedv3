import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgs } from './tenant'
import { leads } from './leads'
import {
  assetKindEnum,
  outreachChannelEnum,
  outreachDirectionEnum,
  outreachStatusEnum,
  trackingEventKindEnum,
} from './enums'

/**
 * Generated assets: microsites (lead.spleed.ai/[slug]), audits, ROI calculators,
 * Loom scripts, demo videos. One Composer output → one row.
 *
 * Decision A — Hybrid shape: 1 table, kind enum + `content` jsonb tagged by
 * version. Type-safety lives in @spleed/shared (AssetContentSchema discriminated
 * union by `kind`, with `version: '1'` baseline for future evolution).
 *
 * Decision E — content stored INLINE. Microsites are JSON structures of ~5-20KB;
 * videos live behind URLs (ogImageUrl, plus future videoUrl in content jsonb).
 * BACKLOG-017 covers migration to Supabase Storage for content >50KB.
 *
 * Soft delete (Decision F): `deleted_at` nullable. Founders unpublish via UPDATE
 * (counter history preserved). The `slug` global unique index is NOT partial —
 * slugs are permanent public URLs and must never be reused, even after unpublish.
 *
 * INVARIANT — slug reservation: slug is permanently reserved across the system
 * post soft-delete. Cannot be reused across different leads/assets. Random
 * suffix in Composer (Sprint 7) prevents practical collisions.
 */
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),

    kind: assetKindEnum('kind').notNull(),
    slug: text('slug').notNull(),

    // Renderer-specific structured content. Zod-validated at write time in
    // @spleed/shared AssetContentSchema (discriminated union by kind, versioned).
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),

    publicUrl: text('public_url').notNull(),
    ogImageUrl: text('og_image_url'),

    // Denormalized counters (Decision C — hybrid). Source of truth for granular
    // events is `tracking_events`; ingest worker updates both atomically.
    viewCount: integer('view_count').notNull().default(0),
    uniqueViewerCount: integer('unique_viewer_count').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),

    // Composer's suggested cold-message text to accompany the asset URL.
    preferredOutreachMessage: text('preferred_outreach_message'),

    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),

    // Soft delete — founder unpublish. slug remains globally unique post-delete.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // GLOBAL unique slug (Micro 1). Public URL `lead.spleed.ai/[slug]` must
    // route deterministically; reusing a slug post-unpublish would hijack a
    // URL previously shared with a different lead.
    slugIdx: uniqueIndex('assets_slug_unique').on(t.slug),
    // Lead detail page: list assets for a lead, filter by kind, only active.
    leadKindActiveIdx: index('assets_lead_kind_active_idx')
      .on(t.leadId, t.kind)
      .where(sql`deleted_at IS NULL`),
    // Dashboard: recently published assets per org.
    orgPublishedActiveIdx: index('assets_org_published_active_idx')
      .on(t.orgId, t.publishedAt)
      .where(sql`deleted_at IS NULL`),
  }),
)

/**
 * Outreach events — every outbound message and every inbound reply.
 *
 * Decision B — state-on-row mutable: a single row per outbound message that
 * mutates through queued → sent → delivered → opened → replied/bounced/failed
 * as provider webhooks (Resend, LinkedIn DM, X) arrive. Inbound replies are
 * separate rows with direction='inbound' and status set by ingest handler.
 *
 * No soft delete: from the founder's view this is an immutable audit. Member
 * RLS is SELECT-only; service role performs INSERT (initial send) and UPDATE
 * (webhook status transitions).
 *
 * Anti-double-send (Decision D, app-layer + DB safety belt):
 *   - Application enforces 3-touches-in-14-days rule (Outreach Operator prompt).
 *   - DB partial unique (lead_id, sequence_position) WHERE direction='outbound'
 *     prevents duplicate "initial" or "followup1" rows on the same lead.
 *
 * Webhook dedup: providerMessageId unique per (org, channel) when present —
 * prevents replaying the same provider webhook into duplicate rows.
 *
 * THREADING (deferred to Sprint 7): inbound/outbound threading not modeled
 * yet. Options on the table: parent_event_id self-reference, provider_thread_id
 * from Resend/LinkedIn, or app-layer join via lead_id + temporal order.
 * Decision lands when we build the inbound reply ingest in Sprint 7.
 */
export const outreachEvents = pgTable(
  'outreach_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    // ON DELETE SET NULL — outbound event retains historical value even if the
    // asset is hard-deleted (rare; assets soft-delete normally).
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),

    channel: outreachChannelEnum('channel').notNull(),
    direction: outreachDirectionEnum('direction').notNull(),

    // Email-only; null for LinkedIn/X/iMessage. Kept as a top-level column
    // (Flag 3) for queryability; revisit in Sprint 12 if needs generalize.
    subject: text('subject'),
    content: text('content').notNull(),

    // Provider IDs for webhook reconciliation (Resend message_id, LinkedIn DM
    // id, X DM id). Required for status transitions arriving over webhooks.
    providerMessageId: text('provider_message_id'),

    status: outreachStatusEnum('status').notNull().default('queued'),

    // Lifecycle timestamps — updated by webhook handlers (service role) as
    // provider events arrive. NULL until that transition occurs.
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),

    // 1=initial outreach, 2=followup1, 3=followup2, etc. NULL for inbound replies.
    sequencePosition: integer('sequence_position'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Full history per lead (lead detail "Outreach" tab).
    leadCreatedIdx: index('outreach_events_lead_created_idx').on(t.leadId, t.createdAt),
    // Worker retry/scan queue: find queued or failed sends.
    orgStatusIdx: index('outreach_events_org_status_idx')
      .on(t.orgId, t.status)
      .where(sql`status IN ('queued', 'failed')`),
    // Anti-double-send safety belt (Decision D).
    outboundSequenceIdx: uniqueIndex('outreach_events_outbound_sequence_unique')
      .on(t.leadId, t.sequencePosition)
      .where(sql`direction = 'outbound'`),
    // Webhook dedup: same provider message can't ingest twice into the same
    // org+channel combination.
    providerMessageIdx: uniqueIndex('outreach_events_provider_message_unique')
      .on(t.orgId, t.channel, t.providerMessageId)
      .where(sql`provider_message_id IS NOT NULL`),
  }),
)

/**
 * Tracking events — pixel hits on microsites, CTA clicks, video plays, calendar
 * open/book. One row per event (append-only event sourcing for this stream).
 *
 * Decision C — hybrid: granular rows here + denormalized counters on
 * `assets.view_count / unique_viewer_count / last_viewed_at`. Outreach Operator
 * (Sprint 7) reads granular rows ("Sarah opened 3x at 9am/11am/4pm") while
 * the dashboard reads counters for fast listings.
 *
 * INVARIANT — atomic counter sync: the ingest worker (Sprint 7) MUST wrap the
 * INSERT tracking_events + UPDATE assets counters in a single SQL transaction.
 * Never two separate writes — desync risk on partial failure.
 *
 * INVARIANT — no raw IP persisted (Micro 2): the ingest endpoint hashes
 * `sha256(asset.id || ':' || ip || ':' || user_agent)` into session_fingerprint
 * BEFORE insert. Raw IP must never appear in this table — not as a column, not
 * inside metadata jsonb. App-layer enforcement only (no DB trigger per Flag 2).
 *
 * No soft delete. Member RLS is SELECT-only; service role performs INSERT.
 */
export const trackingEvents = pgTable(
  'tracking_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),

    kind: trackingEventKindEnum('kind').notNull(),

    // sha256(asset.id + ':' + ip + ':' + user_agent). Per-asset salt prevents
    // cross-asset correlation. Raw IP is NEVER persisted (invariant above).
    sessionFingerprint: text('session_fingerprint'),

    // Referrer header — not PII, useful for outreach analytics.
    referrer: text('referrer'),

    // Per-kind metadata (page viewport, CTA id, video position, slot id).
    // Permissive Record for Sprint 4; discriminated Zod union by kind lands
    // in Sprint 7 when we build the ingest endpoint (Flag 1 deferred).
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Analytics per asset over time.
    assetCreatedIdx: index('tracking_events_asset_created_idx').on(t.assetId, t.createdAt),
    // Outreach Operator queries: "Sarah opened the page 3x" — by kind, recent.
    assetKindCreatedIdx: index('tracking_events_asset_kind_created_idx').on(
      t.assetId,
      t.kind,
      t.createdAt,
    ),
    // Lead-level engagement summary.
    leadKindIdx: index('tracking_events_lead_kind_idx').on(t.leadId, t.kind),
  }),
)
