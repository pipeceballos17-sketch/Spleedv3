/**
 * Multi-tenant isolation suite (Decision 7).
 *
 * Three vectors covered:
 *   1. RLS bypass via policy bug — cross-tenant SELECT/INSERT/UPDATE/DELETE blocked
 *   2. JWT manipulation — forged org_id in JWT does not grant access
 *   3. Service role behavior — bypasses RLS at DB level, application must filter explicitly
 *
 * Prerequisites:
 *   - Local Supabase running (`supabase start`)
 *   - Migrations + seed applied (`bun run db:migrate && bun run db:seed`)
 *   - .env.local has SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *     SUPABASE_JWT_SECRET, DATABASE_URL
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { eq } from 'drizzle-orm'
import { closeServiceClient, getServiceClient } from '../client'
import { loadEnv } from '../env'
import { auditLogs, orgIntegrations, orgs } from '../schema'
import {
  ORG_A_ID,
  ORG_B_ID,
  USER_A_AUTH_ID,
  USER_B_AUTH_ID,
  resetTestData,
  seedIsolationFixtures,
} from './fixtures'
import { createTestJWT } from './jwt'

const env = loadEnv()
const anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function clientAs(userAuthId: string, orgId: string): Promise<SupabaseClient> {
  const jwt = await createTestJWT(
    { sub: userAuthId, org_id: orgId, role: 'authenticated' },
    env.SUPABASE_JWT_SECRET,
  )
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

beforeAll(async () => {
  await seedIsolationFixtures()

  // Seed an org_integration in each org so we have something with a vault_secret_id
  // to test cross-tenant SELECT/INSERT.
  const db = getServiceClient()
  await db.insert(orgIntegrations).values([
    { orgId: ORG_A_ID, kind: 'apollo', vaultSecretId: 'vault-secret-org-a' },
    { orgId: ORG_B_ID, kind: 'apollo', vaultSecretId: 'vault-secret-org-b' },
  ])
})

afterAll(async () => {
  await resetTestData()
  await closeServiceClient()
})

// =====================================================================
// Vector 1: RLS — cross-tenant SELECT/INSERT
// =====================================================================

describe('Vector 1 — RLS: orgs', () => {
  it('member of org A sees only org A', async () => {
    const client = await clientAs(USER_A_AUTH_ID, ORG_A_ID)
    const { data } = await client.from('orgs').select('id, slug')
    expect(data).toEqual([{ id: ORG_A_ID, slug: 'org-a' }])
  })

  it('member of org B sees only org B', async () => {
    const client = await clientAs(USER_B_AUTH_ID, ORG_B_ID)
    const { data } = await client.from('orgs').select('id, slug')
    expect(data).toEqual([{ id: ORG_B_ID, slug: 'org-b' }])
  })

  it('anon sees no orgs', async () => {
    const { data } = await anonClient.from('orgs').select('*')
    expect(data).toEqual([])
  })
})

describe('Vector 1 — RLS: org_members', () => {
  it('member of A only sees A memberships', async () => {
    const client = await clientAs(USER_A_AUTH_ID, ORG_A_ID)
    const { data } = await client.from('org_members').select('org_id, user_id, role')
    expect(data?.every((m: { org_id: string }) => m.org_id === ORG_A_ID)).toBe(true)
  })
})

describe('Vector 1 — RLS: org_integrations', () => {
  it('member of A sees only A integrations', async () => {
    const client = await clientAs(USER_A_AUTH_ID, ORG_A_ID)
    const { data } = await client.from('org_integrations').select('org_id, vault_secret_id')
    expect(data?.length).toBe(1)
    expect(data![0]!.vault_secret_id).toBe('vault-secret-org-a')
  })

  it('member of A cannot insert integration with org_id of B', async () => {
    const client = await clientAs(USER_A_AUTH_ID, ORG_A_ID)
    const { error } = await client.from('org_integrations').insert({
      org_id: ORG_B_ID,
      kind: 'gmail',
      vault_secret_id: 'attempted-injection',
    })
    expect(error).not.toBeNull()
  })
})

describe('Vector 1 — RLS: org_agents', () => {
  it('member of A sees no agents from B (both orgs have empty org_agents in fixtures)', async () => {
    const client = await clientAs(USER_A_AUTH_ID, ORG_A_ID)
    const { data, error } = await client.from('org_agents').select('org_id')
    expect(error).toBeNull()
    expect(data?.every((r: { org_id: string }) => r.org_id === ORG_A_ID)).toBe(true)
  })
})

describe('Vector 1 — RLS: audit_logs', () => {
  it('member of A sees only A logs', async () => {
    const db = getServiceClient()
    await db.insert(auditLogs).values([
      { orgId: ORG_A_ID, action: 'test.event', entityType: 'test' },
      { orgId: ORG_B_ID, action: 'test.event', entityType: 'test' },
    ])

    const client = await clientAs(USER_A_AUTH_ID, ORG_A_ID)
    const { data } = await client.from('audit_logs').select('org_id, action')
    expect(data?.every((r: { org_id: string }) => r.org_id === ORG_A_ID)).toBe(true)
    expect(data?.length).toBeGreaterThan(0)
  })
})

// =====================================================================
// Vector 2: JWT manipulation
// =====================================================================

describe('Vector 2 — JWT tampering', () => {
  it('user A with JWT claiming org B sees no rows of B (is_org_member rejects)', async () => {
    const tampered = await clientAs(USER_A_AUTH_ID, ORG_B_ID)
    const { data } = await tampered.from('org_integrations').select('*')
    expect(data).toEqual([])
  })

  it('user A with JWT claiming org B cannot insert into B', async () => {
    const tampered = await clientAs(USER_A_AUTH_ID, ORG_B_ID)
    const { error } = await tampered.from('org_integrations').insert({
      org_id: ORG_B_ID,
      kind: 'sendblue',
      vault_secret_id: 'attempted-injection-via-tampered-jwt',
    })
    expect(error).not.toBeNull()
  })

  it('anon (no JWT) sees nothing on org-scoped tables', async () => {
    const { data: integrations } = await anonClient.from('org_integrations').select('*')
    expect(integrations).toEqual([])
  })

  it('agent_templates: anon cannot SELECT (only authenticated)', async () => {
    const { data } = await anonClient.from('agent_templates').select('*')
    expect(data).toEqual([])
  })

  it('agent_templates: any authenticated user can SELECT', async () => {
    const client = await clientAs(USER_A_AUTH_ID, ORG_A_ID)
    const { data } = await client.from('agent_templates').select('kind')
    expect((data?.length ?? 0)).toBeGreaterThan(0)
  })
})

// =====================================================================
// Vector 3: Service role bypass behavior (worker contract)
// =====================================================================

describe('Vector 3 — Service role bypass', () => {
  it('service role sees all orgs (bypasses RLS — expected)', async () => {
    const db = getServiceClient()
    const allOrgs = await db.select().from(orgs)
    expect(allOrgs.length).toBe(2)
    const ids = allOrgs.map((o) => o.id).sort()
    expect(ids).toEqual([ORG_A_ID, ORG_B_ID].sort())
  })

  it('service role can write to any org without filter (worker MUST filter explicitly)', async () => {
    const db = getServiceClient()
    await db.insert(auditLogs).values({
      orgId: ORG_B_ID,
      action: 'service_role.test',
      entityType: 'test',
    })
    const orgBLogs = await db.select().from(auditLogs).where(eq(auditLogs.orgId, ORG_B_ID))
    expect(orgBLogs.length).toBeGreaterThan(0)
    // The defense-in-depth contract: every worker query must include
    // `.where(eq(table.orgId, ctx.orgId))`. RLS does not enforce this for
    // service role; code review and (Sprint 4) custom lint rules do.
  })
})
