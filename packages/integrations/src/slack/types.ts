/**
 * Slack Incoming Webhook types (Sprint 5b CP3). Sprint 5b ships text-only
 * messages — Block Kit + interactive buttons land with the full OAuth flow
 * in Sprint 9 (BACKLOG-035).
 */

export interface SlackSendResult {
  /** Whether the webhook POST returned 200. False on mock + on real failure. */
  success: boolean
  /** Mock mode: the rendered payload, so tests can assert message shape. */
  mockedPayload?: { text: string }
}

export interface ScoutFailurePayload {
  runId: string
  icpName: string
  error: { category: string; message: string; code?: string }
}

export interface QuotaExhaustedPayload {
  provider: 'apollo' | 'anthropic'
  /** -1 sentinel when the provider doesn't expose remaining credits in the error. */
  creditsRemaining: number
  /** Optional context to help the founder act (e.g. "upgrade to Pro tier"). */
  upgradeHint?: string
}

// ─── Sprint 7c — Slack OAuth bot (bidirectional DM concierge) ──────

/**
 * Tokens persisted in Supabase Vault keyed by `slack_oauth_{orgId}`.
 * The bot token (xoxb-*) is what the SlackClient uses for postMessage,
 * getUserInfo, etc. — the user access_token is for installed-app flows.
 */
export interface SlackTokens {
  /** User OAuth access token (xoxp-*). */
  access_token: string
  /** Bot user OAuth token (xoxb-*) — used for posting messages. */
  bot_token: string
  /** Slack team (workspace) ID — orgs.slack_team_id lookup key. */
  team_id: string
  /** Bot user ID — orgs.slack_bot_user_id; used to ignore own messages. */
  bot_user_id: string
}

export interface SlackOAuthExchangeResult extends SlackTokens {
  /** Workspace name surfaced by oauth.v2.access — for the "connected" UI. */
  team_name?: string
}

export interface SlackPostMessageInput {
  /** Channel or DM id (D... for IM). */
  channel: string
  /** Plain text fallback. Required by Slack even when blocks are supplied. */
  text?: string
  /** Block Kit message payload. */
  blocks?: SlackBlock[]
  /** Reply in-thread when set — the parent message's ts. */
  thread_ts?: string
}

export interface SlackPostMessageResult {
  ok: boolean
  /** Message timestamp — the thread anchor for follow-ups. */
  ts: string
  /** Channel the message landed in (Slack may rewrite for IMs). */
  channel?: string
}

export interface SlackUserInfo {
  user_id: string
  name: string
  real_name?: string
  /** True when the user is a bot. Caller uses this to filter out self-messages. */
  is_bot?: boolean
}

// ─── Slack event payloads (DM bot, Sprint 7c) ──────────────────────

/** Common shape — Slack wraps every event in this envelope. */
export interface SlackEventEnvelope {
  type: 'url_verification' | 'event_callback'
  challenge?: string
  team_id?: string
  event?: SlackEvent
  api_app_id?: string
  event_id?: string
  event_time?: number
}

/** message.im event — direct message to the bot. */
export interface SlackMessageImEvent {
  type: 'message'
  channel_type: 'im'
  channel: string
  user: string
  text: string
  /** Message timestamp; the concierge worker uses it as the thread root. */
  ts: string
  /**
   * Set for edits/joins/etc. The concierge handler skips any event with a
   * subtype — only fresh user-typed messages should trigger lookups.
   */
  subtype?: string
  /** Set when the message was posted by a bot user (including our own). */
  bot_id?: string
}

export type SlackEvent = SlackMessageImEvent | { type: string; [k: string]: unknown }

// ─── Block Kit (Sprint 7c — dossier card rendering) ────────────────

/**
 * Minimal Block Kit type union — covers what the dossier card uses
 * (header, section + mrkdwn, divider, context). Full Slack block schema
 * is much larger; this stays compact intentionally.
 */
export type SlackBlock =
  | { type: 'header'; text: { type: 'plain_text'; text: string; emoji?: boolean } }
  | { type: 'section'; text: { type: 'mrkdwn' | 'plain_text'; text: string }; fields?: Array<{ type: 'mrkdwn'; text: string }> }
  | { type: 'divider' }
  | { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> }

// ─── buildDossierCard inputs (Sprint 7c) ────────────────────────────
//
// Leaf-typed so the slack package stays free of @spleed/agents +
// @spleed/db imports. The concierge worker maps its real types
// (SynthesizedDossier, DeepResearchOutput, leads row) onto these shapes
// at the call site — TypeScript structural compatibility handles the
// match without runtime adapters.

export interface DossierCardLeadShape {
  fullName?: string | null
  role?: string | null
  company?: string | null
  companyDomain?: string | null
}

export interface DossierCardHook {
  hook: string
  confidence: number
}

export interface DossierCardDeepResearchCategory {
  findings: Array<{ signal: string }>
}

/**
 * Subset of DeepResearchOutput the card builder consumes — just the four
 * core-4 categories. Structurally compatible with the full
 * @spleed/integrations/anthropic.DeepResearchOutput so the concierge
 * worker can pass it through without translation.
 */
export interface DossierCardDeepResearch {
  succession_signals: DossierCardDeepResearchCategory
  hiring_signals: DossierCardDeepResearchCategory
  tech_stack_signals: DossierCardDeepResearchCategory
  recent_activity_signals: DossierCardDeepResearchCategory
}

export interface BuildDossierCardInput {
  lead: DossierCardLeadShape
  /** Synthesized dossier recommended_angle. */
  recommendedAngle: string
  /** Final confidence (Phase 8 ceiling 0.95, Phase 6 ceiling 0.85). */
  confidenceScore: number
  /** Top 3 ranked hooks from the synthesis. */
  topHooks: DossierCardHook[]
  /**
   * Deep research output when Phase 7 ran (null otherwise). When all four
   * categories are empty (Wallace-style), the builder hides the Deep
   * Research section gracefully — confidence footer reflects 3 sources.
   */
  deepResearch?: DossierCardDeepResearch | null
}
