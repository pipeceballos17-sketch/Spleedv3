import { sql } from 'drizzle-orm'
import { getServiceClient } from '../client'
import { orgs, users, orgMembers } from '../schema'

export const ORG_A_ID = '00000000-0000-0000-0000-00000000000a'
export const ORG_B_ID = '00000000-0000-0000-0000-00000000000b'
export const USER_A_ID = '11111111-1111-1111-1111-1111111111aa'
export const USER_B_ID = '11111111-1111-1111-1111-1111111111bb'
export const USER_A_AUTH_ID = '00000000-0000-0000-0000-0000000000a1'
export const USER_B_AUTH_ID = '00000000-0000-0000-0000-0000000000b1'

/**
 * Wipe all org/user data (cascades to memberships, integrations, etc.).
 * Service role bypasses RLS, so this works regardless of policy state.
 */
export async function resetTestData(): Promise<void> {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
}

/**
 * Seed the canonical isolation fixture: 2 orgs, 2 users, 2 owner memberships.
 * Called from beforeAll() in isolation tests.
 */
export async function seedIsolationFixtures(): Promise<void> {
  await resetTestData()
  const db = getServiceClient()

  await db.insert(orgs).values([
    { id: ORG_A_ID, name: 'Org A', slug: 'org-a' },
    { id: ORG_B_ID, name: 'Org B', slug: 'org-b' },
  ])

  await db.insert(users).values([
    {
      id: USER_A_ID,
      supabaseAuthId: USER_A_AUTH_ID,
      email: 'a@test.spleed.ai',
      name: 'User A',
    },
    {
      id: USER_B_ID,
      supabaseAuthId: USER_B_AUTH_ID,
      email: 'b@test.spleed.ai',
      name: 'User B',
    },
  ])

  await db.insert(orgMembers).values([
    { orgId: ORG_A_ID, userId: USER_A_ID, role: 'owner' },
    { orgId: ORG_B_ID, userId: USER_B_ID, role: 'owner' },
  ])
}
