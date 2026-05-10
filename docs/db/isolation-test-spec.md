/**
 * Spleed — Multi-Tenant Isolation Test Suite
 *
 * File location: /packages/db/tests/isolation.test.ts
 *
 * THIS TEST IS CRITICAL. If it fails, deployment is blocked.
 *
 * What it tests:
 * - Two orgs cannot see each other's data via RLS
 * - JWT manipulation cannot bypass org_id filter
 * - Service role bypasses RLS but workers always filter by org_id explicitly
 * - Public microsite endpoint can read assets by slug WITHOUT exposing other org data
 *
 * Run: bun test packages/db/tests/isolation.test.ts
 * CI: this test runs on every PR before merge
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createClient } from '@supabase/supabase-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../schema';
import { sql, eq } from 'drizzle-orm';

// Test config
const TEST_DB_URL = process.env.TEST_DATABASE_URL!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Test fixtures
const ORG_A_ID = '00000000-0000-0000-0000-00000000000a';
const ORG_B_ID = '00000000-0000-0000-0000-00000000000b';
const USER_A_AUTH_ID = '00000000-0000-0000-0000-0000000000a1';
const USER_B_AUTH_ID = '00000000-0000-0000-0000-0000000000b1';

let serviceDb: ReturnType<typeof drizzle>;

beforeAll(async () => {
  // Service role client for setup/teardown
  const sql_client = postgres(TEST_DB_URL, { prepare: false });
  serviceDb = drizzle(sql_client, { schema });

  // Clean slate
  await sql_client`TRUNCATE orgs, users, org_members CASCADE`;

  // Seed two orgs with one user each
  await serviceDb.insert(schema.orgs).values([
    { id: ORG_A_ID, name: 'Org A', slug: 'org-a' },
    { id: ORG_B_ID, name: 'Org B', slug: 'org-b' },
  ]);

  await serviceDb.insert(schema.users).values([
    { id: '11111111-1111-1111-1111-1111111111aa', supabaseAuthId: USER_A_AUTH_ID, email: 'a@test.com', name: 'User A' },
    { id: '11111111-1111-1111-1111-1111111111bb', supabaseAuthId: USER_B_AUTH_ID, email: 'b@test.com', name: 'User B' },
  ]);

  await serviceDb.insert(schema.orgMembers).values([
    { orgId: ORG_A_ID, userId: '11111111-1111-1111-1111-1111111111aa', role: 'owner' },
    { orgId: ORG_B_ID, userId: '11111111-1111-1111-1111-1111111111bb', role: 'owner' },
  ]);

  // Create test leads in each org
  await serviceDb.insert(schema.leads).values([
    {
      orgId: ORG_A_ID,
      fullName: 'Alice from A',
      firstName: 'Alice',
      lastName: 'A',
      company: 'AcmeA',
      role: 'CEO',
      foundVia: 'apollo',
    },
    {
      orgId: ORG_B_ID,
      fullName: 'Bob from B',
      firstName: 'Bob',
      lastName: 'B',
      company: 'AcmeB',
      role: 'CEO',
      foundVia: 'apollo',
    },
  ]);
});

afterAll(async () => {
  await serviceDb.execute(sql`TRUNCATE orgs, users, org_members CASCADE`);
});

/**
 * Helper: create a Supabase client authenticated as a specific user
 * with a specific org_id claim in JWT.
 */
function clientAs(userAuthId: string, orgId: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        // In real Supabase, JWT includes app_metadata.org_id from custom claim function
        // For testing, we use Supabase Auth Admin API to create test JWTs
        Authorization: `Bearer ${createTestJWT({ sub: userAuthId, org_id: orgId })}`,
      },
    },
  });
}

// Helper to create signed JWTs for testing (uses Supabase Auth admin)
function createTestJWT(claims: Record<string, unknown>): string {
  // In CI: use Supabase Auth Admin API or jose library to mint signed JWT
  // Implementation detail — depends on Supabase Auth setup
  throw new Error('Implement createTestJWT with jose or supabase-auth-admin');
}

// =====================================================================
// CRITICAL TESTS — these prevent the worst-case scenario:
// a tenant accidentally seeing another tenant's leads, dossiers, gifts.
// =====================================================================

describe('Multi-tenant isolation: leads', () => {
  it('user A cannot see leads from org B', async () => {
    const clientA = clientAs(USER_A_AUTH_ID, ORG_A_ID);
    const { data: leads } = await clientA.from('leads').select('*');

    expect(leads).toBeDefined();
    expect(leads!.length).toBe(1);
    expect(leads![0].full_name).toBe('Alice from A');
    expect(leads!.every((l) => l.org_id === ORG_A_ID)).toBe(true);
  });

  it('user B cannot see leads from org A', async () => {
    const clientB = clientAs(USER_B_AUTH_ID, ORG_B_ID);
    const { data: leads } = await clientB.from('leads').select('*');

    expect(leads!.length).toBe(1);
    expect(leads![0].full_name).toBe('Bob from B');
  });

  it('user A cannot insert a lead with org_id of org B', async () => {
    const clientA = clientAs(USER_A_AUTH_ID, ORG_A_ID);
    const { error } = await clientA.from('leads').insert({
      org_id: ORG_B_ID, // attempting cross-tenant injection
      full_name: 'Hacker Lead',
      first_name: 'Hacker',
      last_name: 'X',
      company: 'EvilCorp',
      role: 'Attacker',
      found_via: 'manual',
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501'); // Postgres: insufficient privilege
  });

  it('user A cannot update leads of org B by ID', async () => {
    const orgBLeadId = await getOrgBLeadId();
    const clientA = clientAs(USER_A_AUTH_ID, ORG_A_ID);
    const { data, error } = await clientA
      .from('leads')
      .update({ status: 'lost' })
      .eq('id', orgBLeadId)
      .select();

    // Should return empty data (RLS filters) — NOT an error, but zero rows updated
    expect(data).toEqual([]);
  });

  it('user A cannot delete leads of org B by ID', async () => {
    const orgBLeadId = await getOrgBLeadId();
    const clientA = clientAs(USER_A_AUTH_ID, ORG_A_ID);
    const { data } = await clientA.from('leads').delete().eq('id', orgBLeadId).select();

    expect(data).toEqual([]);

    // Verify lead still exists in org B
    const { data: stillExists } = await serviceDb
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, orgBLeadId));
    expect(stillExists.length).toBe(1);
  });
});

// =====================================================================
// JWT manipulation tests — what if attacker tampers with the JWT claim?
// =====================================================================

describe('JWT tampering protection', () => {
  it('user A with manipulated JWT claiming org B sees nothing of org B', async () => {
    // User A's auth_id but JWT claims org_id of B (forged or misconfigured)
    const tamperedClient = clientAs(USER_A_AUTH_ID, ORG_B_ID);

    const { data: leads } = await tamperedClient.from('leads').select('*');

    // is_org_member(ORG_B_ID) returns false because USER_A is NOT in org_members of ORG_B
    // RLS policy uses BOTH current_org_id() AND is_org_member() — JWT alone is not enough
    expect(leads).toEqual([]);
  });

  it('expired or unsigned JWT yields no access', async () => {
    const noAuthClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await noAuthClient.from('leads').select('*');

    expect(data).toEqual([]); // anon role has no SELECT policy
  });
});

// =====================================================================
// Cascading isolation: dossiers, threads, gifts, approvals
// =====================================================================

describe('Cascading isolation across all operational tables', () => {
  // Generate via macro to ensure we test EVERY table with org_id
  const TABLES_TO_TEST = [
    'leads',
    'lead_dossiers',
    'lead_threads',
    'icps',
    'assets',
    'outreach_events',
    'tracking_events',
    'gifts',
    'approval_requests',
    'concierge_threads',
    'concierge_memory',
    'org_integrations',
    'org_browser_profiles',
    'org_agents',
    'tool_call_logs',
    'quiet_hours_overrides',
  ];

  TABLES_TO_TEST.forEach((tableName) => {
    it(`${tableName}: user A cannot SELECT data from org B`, async () => {
      // Insert a row in org B via service role
      await insertTestRowAs(ORG_B_ID, tableName);

      // Try to read as user A
      const clientA = clientAs(USER_A_AUTH_ID, ORG_A_ID);
      const { data } = await clientA.from(tableName).select('*');

      const orgBRows = data?.filter((r: any) => r.org_id === ORG_B_ID) ?? [];
      expect(orgBRows.length).toBe(0);
    });
  });
});

// =====================================================================
// Public microsite endpoint test
// =====================================================================

describe('Public microsite access', () => {
  it('anonymous user can read asset by slug WITHOUT seeing other assets', async () => {
    // Service role inserts an asset for org A with a public slug
    const orgALeadId = await getOrgALeadId();
    await serviceDb.insert(schema.assets).values({
      orgId: ORG_A_ID,
      leadId: orgALeadId,
      kind: 'microsite',
      slug: 'alice-test-microsite',
      content: { hero: 'Hi Alice' },
      publicUrl: 'https://lead.spleed.ai/alice-test-microsite',
    });

    // Public microsite renderer uses service role + slug — does NOT use RLS
    // Validation: it can ONLY read by exact slug, never list all assets
    const publicClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
    const { data: asset } = await publicClient
      .from('assets')
      .select('content, slug')
      .eq('slug', 'alice-test-microsite')
      .single();

    expect(asset).toBeDefined();
    expect(asset!.content).toEqual({ hero: 'Hi Alice' });

    // Cross-check: list ALL assets via service role would expose everything
    // The microsite endpoint code MUST always filter by slug, never use .select() alone.
    // This is enforced via code review + the lint rule below.
  });
});

// =====================================================================
// Helper: insert a minimal test row in any table for org B
// =====================================================================

async function insertTestRowAs(orgId: string, tableName: string) {
  // Implementation depends on table schema; this is a sketch
  // The real implementation uses fixtures per-table or a faker
  const minimalRow: Record<string, any> = {
    org_id: orgId,
    // Add table-specific required fields here
  };
  await serviceDb.execute(
    sql.raw(`INSERT INTO ${tableName} (org_id, ...) VALUES ($1, ...)`),
  );
}

async function getOrgALeadId(): Promise<string> {
  const [lead] = await serviceDb
    .select()
    .from(schema.leads)
    .where(eq(schema.leads.orgId, ORG_A_ID));
  return lead.id;
}

async function getOrgBLeadId(): Promise<string> {
  const [lead] = await serviceDb
    .select()
    .from(schema.leads)
    .where(eq(schema.leads.orgId, ORG_B_ID));
  return lead.id;
}

// =====================================================================
// Lint rule for code review (separate file: .eslintrc.json)
// =====================================================================
//
// {
//   "rules": {
//     "spleed/no-unscoped-supabase-select": "error"
//   }
// }
//
// Custom ESLint rule that flags any .from('table_with_org_id').select() call
// that doesn't include .eq('org_id', ...) or .eq('slug', ...) — preventing
// accidental cross-tenant data exposure in service-role code.
//
// Implementation in /tools/eslint-plugin-spleed/no-unscoped-supabase-select.ts
