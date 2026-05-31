import { mockResendSend } from './mock'
import { getResendApiKey } from './token-store'
import type { ResendSendInput, ResendSendResult, ResendTestConnectionResult } from './types'

const RESEND_API_BASE = 'https://api.resend.com'

export interface ResendClientConfig {
  /** Explicit key (bypasses Vault). Sprint 9.5 self-send can pass it directly. */
  apiKey?: string
  /** Tenant — live mode loads the key from Vault (getResendApiKey) when no apiKey. */
  orgId?: string
  /** Force mock mode. Default: RESEND_LIVE !== 'true'. */
  mockMode?: boolean
}

/**
 * Resend email client (Sprint 9 CP4). Mock-default — send() returns a
 * deterministic synthetic id with no network. The live POST is fully wired but
 * only the deliberate Sprint 9.5 first-send (RESEND_LIVE=true) exercises it.
 */
export class ResendClient {
  readonly mockMode: boolean
  private readonly apiKey?: string
  private readonly orgId?: string

  constructor(config: ResendClientConfig = {}) {
    this.apiKey = config.apiKey
    this.orgId = config.orgId
    this.mockMode = config.mockMode ?? process.env.RESEND_LIVE !== 'true'
  }

  async send(input: ResendSendInput): Promise<ResendSendResult> {
    if (this.mockMode) return mockResendSend(input)
    return this.sendLive(input)
  }

  /**
   * Validate a tenant key. Mock-default: format check (`re_*`). Live (Sprint
   * 9.5+): GET /domains with the key — 200 = ok, 401 = INVALID_KEY.
   */
  async testConnection(apiKey: string): Promise<ResendTestConnectionResult> {
    if (this.mockMode) {
      return /^re_/.test(apiKey) ? { ok: true } : { ok: false, error: 'INVALID_KEY' }
    }
    try {
      const res = await fetch(`${RESEND_API_BASE}/domains`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (res.ok) return { ok: true }
      return { ok: false, error: res.status === 401 ? 'INVALID_KEY' : 'CONNECTION_FAILED' }
    } catch {
      return { ok: false, error: 'CONNECTION_FAILED' }
    }
  }

  private async sendLive(input: ResendSendInput): Promise<ResendSendResult> {
    // Key precedence: explicit apiKey, else the tenant's Vault key. (Vault live
    // RPC lands Sprint 9.5+ / BACKLOG-044; until then a live send must pass the
    // key directly.)
    const key = this.apiKey ?? (this.orgId ? await getResendApiKey(this.orgId) : null)
    if (!key) {
      throw new Error('[resend] live send requires an apiKey or a Vault-stored key for orgId')
    }
    const res = await fetch(`${RESEND_API_BASE}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
      }),
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { message?: string; name?: string }
      throw new Error(`[resend] send failed ${res.status}: ${err.name ?? ''} ${err.message ?? res.statusText}`)
    }
    const data = (await res.json()) as { id: string }
    return { id: data.id }
  }
}
