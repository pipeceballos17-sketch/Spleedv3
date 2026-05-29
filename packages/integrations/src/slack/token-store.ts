/**
 * Slack OAuth token storage (Sprint 7c).
 *
 * Real bot/user tokens belong in Supabase Vault keyed by
 * `slack_oauth_{orgId}` (see orgs.slack_team_id comment in
 * @spleed/db schema/tenant.ts). Sprint 7c has no Vault RPC wiring yet —
 * Scout/Profiler used literal 'mock' keys too — so this is mock-default: an
 * in-process Map stands in for Vault so the OAuth callback (apps/api) and the
 * concierge worker (@spleed/agents) can round-trip tokens in the same
 * co-located process (Sprint 7c boots workers inside the API process).
 *
 * Lives in @spleed/integrations/slack (not apps/api) because BOTH the API
 * (store on OAuth callback) and the worker (read on Slack event) consume it,
 * and a package can't import from apps/api. Token storage is a Slack-
 * integration concern, same layer as SlackClient + signature verification.
 *
 * Live path (Sprint 8+, BACKLOG-044): swap the Map for Supabase Vault
 * `vault.create_secret` / `vault.decrypted_secrets` RPCs + upsert
 * org_integrations(kind='slack', vault_secret_id). That also needs 'slack'
 * added to the integration_kind enum (new migration).
 *
 * Mock-default gate mirrors the integration clients (SLACK_LIVE !== 'true').
 */

import type { SlackTokens } from './types'

function isMockByDefault(): boolean {
  return process.env.SLACK_LIVE !== 'true'
}

/** In-process stand-in for Supabase Vault. Keyed by `slack_oauth_{orgId}`. */
const MOCK_VAULT = new Map<string, SlackTokens>()

function vaultKey(orgId: string): string {
  return `slack_oauth_${orgId}`
}

/** Test/demo seam — wipe the in-memory store between cases. */
export function resetMockSlackTokenStore(): void {
  MOCK_VAULT.clear()
}

export async function storeSlackOAuthTokens(
  orgId: string,
  tokens: SlackTokens,
): Promise<void> {
  if (isMockByDefault()) {
    MOCK_VAULT.set(vaultKey(orgId), tokens)
    return
  }
  return storeSlackOAuthTokensLive(orgId, tokens)
}

export async function getSlackOAuthTokens(orgId: string): Promise<SlackTokens | null> {
  if (isMockByDefault()) {
    return MOCK_VAULT.get(vaultKey(orgId)) ?? null
  }
  return getSlackOAuthTokensLive(orgId)
}

export async function deleteSlackOAuthTokens(orgId: string): Promise<void> {
  if (isMockByDefault()) {
    MOCK_VAULT.delete(vaultKey(orgId))
    return
  }
  return deleteSlackOAuthTokensLive(orgId)
}

// ─── Live stubs (Sprint 8+ — Supabase Vault RPC, BACKLOG-044) ─────────

async function storeSlackOAuthTokensLive(
  _orgId: string,
  _tokens: SlackTokens,
): Promise<void> {
  // vault.create_secret(JSON.stringify(tokens), `slack_oauth_${orgId}`) then
  // upsert org_integrations(org_id, kind='slack', vault_secret_id=<id>).
  throw new Error(
    '[slack-token-store] live mode not implemented in Sprint 7c — wire Supabase Vault RPC in Sprint 8+ (BACKLOG-044)',
  )
}

async function getSlackOAuthTokensLive(_orgId: string): Promise<SlackTokens | null> {
  // Read org_integrations.vault_secret_id, then vault.decrypted_secrets
  // WHERE id = vault_secret_id; JSON.parse the value.
  throw new Error(
    '[slack-token-store] live mode not implemented in Sprint 7c — wire Supabase Vault RPC in Sprint 8+ (BACKLOG-044)',
  )
}

async function deleteSlackOAuthTokensLive(_orgId: string): Promise<void> {
  // Delete the vault secret + the org_integrations row (uninstall flow).
  throw new Error(
    '[slack-token-store] live mode not implemented in Sprint 7c — wire Supabase Vault RPC in Sprint 8+ (BACKLOG-044)',
  )
}
