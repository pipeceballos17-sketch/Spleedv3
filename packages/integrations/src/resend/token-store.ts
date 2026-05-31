/**
 * Resend BYOK key storage (Sprint 9 CP4).
 *
 * Clone of anthropic/token-store.ts: the real per-tenant key lives in Supabase
 * Vault keyed by `resend_api_key_{orgId}` (orgs.resend_vault_ref holds the
 * reference). Mock-default in-process Map so the BYOK flow + the Outreach
 * Operator's live key load round-trip in the same process. Live Vault RPC
 * deferred to Sprint 9.5+ (BACKLOG-044).
 *
 * Gate mirrors the client (RESEND_LIVE !== 'true').
 */

function isMockByDefault(): boolean {
  return process.env.RESEND_LIVE !== 'true'
}

/** In-process stand-in for Supabase Vault. Keyed by `resend_api_key_{orgId}`. */
const MOCK_VAULT = new Map<string, string>()

function vaultKey(orgId: string): string {
  return `resend_api_key_${orgId}`
}

/** Test/demo seam — wipe the in-memory store between cases. */
export function resetMockResendTokenStore(): void {
  MOCK_VAULT.clear()
}

export async function storeResendApiKey(orgId: string, apiKey: string): Promise<void> {
  if (isMockByDefault()) {
    MOCK_VAULT.set(vaultKey(orgId), apiKey)
    return
  }
  return storeResendApiKeyLive(orgId, apiKey)
}

export async function getResendApiKey(orgId: string): Promise<string | null> {
  if (isMockByDefault()) {
    return MOCK_VAULT.get(vaultKey(orgId)) ?? null
  }
  return getResendApiKeyLive(orgId)
}

export async function deleteResendApiKey(orgId: string): Promise<void> {
  if (isMockByDefault()) {
    MOCK_VAULT.delete(vaultKey(orgId))
    return
  }
  return deleteResendApiKeyLive(orgId)
}

// ─── Live stubs (Sprint 9.5+ — Supabase Vault RPC, BACKLOG-044) ───────

async function storeResendApiKeyLive(_orgId: string, _apiKey: string): Promise<void> {
  throw new Error(
    '[resend-token-store] live mode not implemented in Sprint 9 CP4 — wire Supabase Vault RPC in Sprint 9.5+ (BACKLOG-044)',
  )
}

async function getResendApiKeyLive(_orgId: string): Promise<string | null> {
  throw new Error(
    '[resend-token-store] live mode not implemented in Sprint 9 CP4 — wire Supabase Vault RPC in Sprint 9.5+ (BACKLOG-044)',
  )
}

async function deleteResendApiKeyLive(_orgId: string): Promise<void> {
  throw new Error(
    '[resend-token-store] live mode not implemented in Sprint 9 CP4 — wire Supabase Vault RPC in Sprint 9.5+ (BACKLOG-044)',
  )
}
