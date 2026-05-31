/**
 * Resend client + token-store tests (Sprint 9 CP4 — 3 tests).
 *
 * Client-layer unit tests (no DB / agents). Mock-default like every
 * integration client; the live path is exercised with a stubbed global fetch
 * (never hits api.resend.com).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { ResendClient } from '../client'
import {
  deleteResendApiKey,
  getResendApiKey,
  resetMockResendTokenStore,
  storeResendApiKey,
} from '../token-store'

describe('ResendClient.send (Sprint 9 CP4)', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('mock-default send → deterministic mock-resend-<hash> id, no network', async () => {
    const captured = { fetchCalled: false }
    globalThis.fetch = (async () => {
      captured.fetchCalled = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const client = new ResendClient({ orgId: 'demo' })
    expect(client.mockMode).toBe(true)
    const input = { from: 'a@x.com', to: 'lead@acme.com', subject: 'Hello', text: 'Body' }
    const r1 = await client.send(input)
    const r2 = await client.send(input)
    expect(r1.id).toMatch(/^mock-resend-[0-9a-f]+$/)
    expect(r2.id).toBe(r1.id) // deterministic — same (to, subject) → same id
    expect(captured.fetchCalled).toBe(false) // mock path never touches the network
  })

  it('RESEND_LIVE gate: mockMode=false attempts the live POST (stubbed fetch)', async () => {
    const captured: { url?: string; auth?: string } = {}
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured.url = url
      captured.auth = (init?.headers as Record<string, string>)?.Authorization
      return new Response(JSON.stringify({ id: 'live-resend-id-1' }), { status: 200 })
    }) as unknown as typeof fetch

    // Explicit apiKey + mockMode:false → live path, no env mutation, no real call.
    const client = new ResendClient({ apiKey: 're_live_key', mockMode: false })
    const r = await client.send({ from: 'a@x.com', to: 'lead@acme.com', subject: 'S', text: 'B' })
    expect(r.id).toBe('live-resend-id-1')
    expect(captured.url).toBe('https://api.resend.com/emails')
    expect(captured.auth).toBe('Bearer re_live_key')
  })
})

describe('Resend token-store round-trip (Sprint 9 CP4)', () => {
  it('store → get → delete (mock Map)', async () => {
    resetMockResendTokenStore()
    const ORG = 'org-resend-roundtrip'
    expect(await getResendApiKey(ORG)).toBeNull()

    await storeResendApiKey(ORG, 're_stored_key')
    expect(await getResendApiKey(ORG)).toBe('re_stored_key')

    await deleteResendApiKey(ORG)
    expect(await getResendApiKey(ORG)).toBeNull()
  })
})
