import { pgEnum } from 'drizzle-orm/pg-core'

export const planEnum = pgEnum('plan', ['founder', 'team', 'scale'])

export const memberRoleEnum = pgEnum('member_role', ['owner', 'member'])

export const integrationKindEnum = pgEnum('integration_kind', [
  'apollo',
  'gmail',
  'sendblue',
  'stripe_issuing',
  'cal_com',
  'resend',
  'apify',
])

export const integrationStatusEnum = pgEnum('integration_status', [
  'connected',
  'expired',
  'error',
  'disconnected',
])

export const agentKindEnum = pgEnum('agent_kind', [
  'scout',
  'profiler',
  'composer',
  'outreach',
  'gifter',
  'concierge',
])

export const verbosityEnum = pgEnum('verbosity', ['terse', 'normal', 'detailed'])

// Lead lifecycle. Transitions are informational (documented in 05-policies.sql
// via COMMENT ON TYPE), enforced at application layer not at DB.
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
])

export const leadThreadRoleEnum = pgEnum('lead_thread_role', [
  'agent',
  'user',
  'tool',
  'system',
])

// Sprint 4 — outreach pipeline

export const assetKindEnum = pgEnum('asset_kind', [
  'microsite',
  'demo_video',
  'audit_pdf',
  'roi_calculator',
  'loom_script',
])

export const outreachChannelEnum = pgEnum('outreach_channel', [
  'email',
  'linkedin',
  'x',
  'imessage',
])

export const outreachDirectionEnum = pgEnum('outreach_direction', [
  'outbound',
  'inbound',
])

// Outreach lifecycle. State-on-row pattern (Decision B): a single row mutates
// through these states via provider webhook updates. Member RLS is SELECT-only;
// service role performs all INSERTs and status UPDATEs.
export const outreachStatusEnum = pgEnum('outreach_status', [
  'queued',
  'sent',
  'delivered',
  'opened',
  'replied',
  'bounced',
  'failed',
])

export const trackingEventKindEnum = pgEnum('tracking_event_kind', [
  'page_view',
  'cta_click',
  'video_play',
  'calendar_open',
  'calendar_book',
])
