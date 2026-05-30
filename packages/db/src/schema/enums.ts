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
  'hermes',
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

// Sprint 5 — Scout runs + cost tracking

export const scoutRunStatusEnum = pgEnum('scout_run_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'partial',
])

export const scoutTriggerTypeEnum = pgEnum('scout_trigger_type', [
  'cron',
  'on_demand',
  'manual_test',
])

export const costProviderEnum = pgEnum('cost_provider', [
  'apollo',
  'apify',
  'anthropic',
  'openai',
  'sendblue',
  'slack',
  'resend',
  // Sprint 6 — Vercel agent-browser for company website + news scraping (Profiler).
  'vercel_browser',
])

// Sprint 8 — Composer + Outreach pipeline (drafts, unsubscribes, replies).
// pgEnum (not text+CHECK) to match every other enumerated column in this
// schema (lead_status, outreach_status, cost_provider, …).

// outreach_drafts lifecycle. Composer (service role) inserts 'pending_approval';
// the Slack approval handler / dashboard transitions the rest. 'regenerated'
// marks a superseded draft when the founder hits 🔄 Regenerate (Sprint 8.2).
export const outreachDraftStatusEnum = pgEnum('outreach_draft_status', [
  'pending_approval',
  'approved',
  'sent',
  'rejected',
  'regenerated',
  'failed',
])

// How an unsubscribe was captured. 'link_click' (microsite/email link),
// 'reply_stop' (STOP/UNSUBSCRIBE in a reply), 'manual' (founder), 'webhook'.
export const outreachUnsubscribeSourceEnum = pgEnum('outreach_unsubscribe_source', [
  'link_click',
  'reply_stop',
  'manual',
  'webhook',
])

// Where an inbound reply arrived from. 'mock' covers Sprint 8 testing before
// Sendblue/IMAP live wiring (Sprint 9+).
export const outreachReplyProviderEnum = pgEnum('outreach_reply_provider', [
  'sendblue',
  'email_imap',
  'manual_forward',
  'mock',
])

// LLM-classified intent of an inbound reply (nullable column — null = unclassified).
export const outreachReplyIntentEnum = pgEnum('outreach_reply_intent', [
  'engaged',
  'declined',
  'unsubscribe',
  'other',
])
