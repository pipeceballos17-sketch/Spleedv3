/**
 * Anthropic BYOK key storage (Sprint 8.2 — Decision 9).
 *
 * The real per-tenant API key belongs in Supabase Vault keyed by
 * `anthropic_api_key_{orgId}` (orgs.anthropic_vault_ref holds the reference).
 * Sprint 8.2 has no Vault RPC wiring yet, so this is mock-default: an
 * in-process Map stands in for Vault so the guided BYOK flow + per-tenant
 * client loading round-trip in the same process (tests + the local demo).
 *
 * Identical architecture to slack/token-store.ts (Sprint 7c) — token storage
 * is an integration concern, consumed by both apps/api (store on verify) and
 * the AnthropicClient (load per-tenant key when ANTHROPIC_LIVE).
 *
 * Live path (Sprint 9+, BACKLOG-044): swap the Map for Supabase Vault
 * create_secret / decrypted_secrets RPCs + the org_integrations(kind='anthropic')
 * row.
 *
 * Mock-default gate mirrors the clients (ANTHROPIC_LIVE !== 'true').
 */

function isMockByDefault(): boolean {
  return process.env.ANTHROPIC_LIVE !== 'true'
}

/** In-process stand-in for Supabase Vault. Keyed by `anthropic_api_key_{orgId}`. */
const MOCK_VAULT = new Map<string, string>()

function vaultKey(orgId: string): string {
  return `anthropic_api_key_${orgId}`
}

/** Test/demo seam — wipe the in-memory store between cases. */
export function resetMockAnthropicTokenStore(): void {
  MOCK_VAULT.clear()
}

export async function storeAnthropicApiKey(orgId: string, apiKey: string): Promise<void> {
  if (isMockByDefault()) {
    MOCK_VAULT.set(vaultKey(orgId), apiKey)
    return
  }
  return storeAnthropicApiKeyLive(orgId, apiKey)
}

export async function getAnthropicApiKey(orgId: string): Promise<string | null> {
  if (isMockByDefault()) {
    return MOCK_VAULT.get(vaultKey(orgId)) ?? null
  }
  return getAnthropicApiKeyLive(orgId)
}

export async function deleteAnthropicApiKey(orgId: string): Promise<void> {
  if (isMockByDefault()) {
    MOCK_VAULT.delete(vaultKey(orgId))
    return
  }
  return deleteAnthropicApiKeyLive(orgId)
}

// ─── Live stubs (Sprint 9+ — Supabase Vault RPC, BACKLOG-044) ─────────

async function storeAnthropicApiKeyLive(_orgId: string, _apiKey: string): Promise<void> {
  throw new Error(
    '[anthropic-token-store] live mode not implemented in Sprint 8.2 — wire Supabase Vault RPC in Sprint 9+ (BACKLOG-044)',
  )
}

async function getAnthropicApiKeyLive(_orgId: string): Promise<string | null> {
  throw new Error(
    '[anthropic-token-store] live mode not implemented in Sprint 8.2 — wire Supabase Vault RPC in Sprint 9+ (BACKLOG-044)',
  )
}

async function deleteAnthropicApiKeyLive(_orgId: string): Promise<void> {
  throw new Error(
    '[anthropic-token-store] live mode not implemented in Sprint 8.2 — wire Supabase Vault RPC in Sprint 9+ (BACKLOG-044)',
  )
}
