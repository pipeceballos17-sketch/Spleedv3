-- =====================================================================
-- Spleed — RLS Policies + Helpers (Sprint 1 deliverable)
-- =====================================================================
--
-- Apply order:
--   1. Run drizzle-kit push to create tables (schema.ts)
--   2. Run helpers.sql (this file's first section) for current_org_id() function
--   3. Run policies.sql (this file's second section) to enable RLS on all tables
--   4. Run isolation tests (TypeScript file, separate)
--
-- CRITICAL: After Sprint 1, NEVER add a new table without applying RLS.
-- The CI test suite must include the new table in the isolation test.
-- =====================================================================

-- =====================================================================
-- SECTION 1: helpers.sql
-- =====================================================================
--
-- CRITICAL: helpers that read from auxiliary tables (public.users, public.org_members)
-- MUST be declared SECURITY DEFINER. Without it, the function inherits the caller's
-- RLS context, and any SELECT it issues against those tables fires their own RLS
-- policies recursively. For example, is_org_member SELECTs from org_members, whose
-- own SELECT policy calls is_org_member(org_id) — infinite recursion. Postgres
-- detects the loop and aborts with NULL data, so the caller (test/app) sees
-- null instead of the expected rows and isolation tests fail confusingly.
--
-- SECURITY DEFINER runs the function as its owner (postgres) and bypasses RLS on
-- the auxiliary tables. Combined with SET search_path = '' and fully-qualified
-- references (public.users, auth.uid()), this is the canonical Supabase pattern
-- for RLS helpers; it also prevents search_path injection in a definer context.
--
-- Functions that touch ONLY JWT claims (no table reads) — like current_org_id —
-- stay as plain STABLE; SECURITY DEFINER is unnecessary and adds attack surface
-- for no benefit.

-- Returns the org_id from the JWT claim. NULL if not authenticated.
-- The Custom Access Token Hook (03-access-token-hook.sql) injects this claim.
-- No table access → plain STABLE; SECURITY DEFINER not required.
CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::json ->> 'org_id',
    ''
  )::uuid;
$$;

-- Returns true if the current user has owner role in the given org.
CREATE OR REPLACE FUNCTION public.is_org_owner(check_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_members om
    INNER JOIN public.users u ON u.id = om.user_id
    WHERE om.org_id = check_org_id
      AND u.supabase_auth_id = auth.uid()
      AND om.role = 'owner'
  );
$$;

-- Returns true if the current authenticated user is a member of the given org.
CREATE OR REPLACE FUNCTION public.is_org_member(check_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_members om
    INNER JOIN public.users u ON u.id = om.user_id
    WHERE om.org_id = check_org_id
      AND u.supabase_auth_id = auth.uid()
  );
$$;

-- Returns the user_id of the currently authenticated user.
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS uuid
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT id FROM public.users WHERE supabase_auth_id = auth.uid();
$$;

-- =====================================================================
-- SECTION 2: policies.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- TENANT TABLES
-- ---------------------------------------------------------------------

ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;

CREATE POLICY orgs_member_select ON orgs FOR SELECT
  USING (is_org_member(id));

CREATE POLICY orgs_owner_update ON orgs FOR UPDATE
  USING (is_org_owner(id))
  WITH CHECK (is_org_owner(id));

-- Users table: a user can only see themselves
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_self_select ON users FOR SELECT
  USING (supabase_auth_id = auth.uid());

CREATE POLICY users_self_update ON users FOR UPDATE
  USING (supabase_auth_id = auth.uid())
  WITH CHECK (supabase_auth_id = auth.uid());

-- Org members: visible to fellow members of the same org
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_members_member_select ON org_members FOR SELECT
  USING (is_org_member(org_id));

CREATE POLICY org_members_owner_modify ON org_members FOR ALL
  USING (is_org_owner(org_id))
  WITH CHECK (is_org_owner(org_id));

-- Quiet hours overrides: each member manages their own
ALTER TABLE quiet_hours_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY quiet_hours_self_all ON quiet_hours_overrides FOR ALL
  USING (org_id = current_org_id() AND user_id = current_user_id())
  WITH CHECK (org_id = current_org_id() AND user_id = current_user_id());

-- ---------------------------------------------------------------------
-- INTEGRATION TABLES
-- ---------------------------------------------------------------------

ALTER TABLE org_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_integrations_member_select ON org_integrations FOR SELECT
  USING (org_id = current_org_id() AND is_org_member(org_id));

CREATE POLICY org_integrations_owner_modify ON org_integrations FOR ALL
  USING (org_id = current_org_id() AND is_org_owner(org_id))
  WITH CHECK (org_id = current_org_id() AND is_org_owner(org_id));

ALTER TABLE org_browser_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_browser_profiles_owner_all ON org_browser_profiles FOR ALL
  USING (org_id = current_org_id() AND is_org_owner(org_id))
  WITH CHECK (org_id = current_org_id() AND is_org_owner(org_id));

-- ---------------------------------------------------------------------
-- AGENT TABLES
-- ---------------------------------------------------------------------

-- agent_templates is read-only reference data, no RLS (system-wide)
-- BUT we still ENABLE RLS for safety, allowing only SELECT for authenticated
ALTER TABLE agent_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_templates_authenticated_select ON agent_templates FOR SELECT
  USING (auth.role() = 'authenticated');

ALTER TABLE org_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_agents_member_all ON org_agents FOR ALL
  USING (org_id = current_org_id() AND is_org_member(org_id))
  WITH CHECK (org_id = current_org_id() AND is_org_member(org_id));

ALTER TABLE tool_call_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tool_call_logs_member_select ON tool_call_logs FOR SELECT
  USING (org_id = current_org_id() AND is_org_member(org_id));

-- Insert from service role only (workers running as service)
-- No INSERT policy = no insert from authenticated users; service role bypasses RLS

-- ---------------------------------------------------------------------
-- LEADS TABLES
-- ---------------------------------------------------------------------

ALTER TABLE icps ENABLE ROW LEVEL SECURITY;

CREATE POLICY icps_member_all ON icps FOR ALL
  USING (org_id = current_org_id() AND is_org_member(org_id))
  WITH CHECK (org_id = current_org_id() AND is_org_member(org_id));

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY leads_member_all ON leads FOR ALL
  USING (org_id = current_org_id() AND is_org_member(org_id))
  WITH CHECK (org_id = current_org_id() AND is_org_member(org_id));

ALTER TABLE lead_dossiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_dossiers_member_all ON lead_dossiers FOR ALL
  USING (org_id = current_org_id() AND is_org_member(org_id))
  WITH CHECK (org_id = current_org_id() AND is_org_member(org_id));

ALTER TABLE lead_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_threads_member_select ON lead_threads FOR SELECT
  USING (org_id = current_org_id() AND is_org_member(org_id));

CREATE POLICY lead_threads_member_insert ON lead_threads FOR INSERT
  WITH CHECK (org_id = current_org_id() AND is_org_member(org_id));

-- No UPDATE/DELETE — threads are append-only audit log

-- ---------------------------------------------------------------------
-- OUTREACH TABLES
-- ---------------------------------------------------------------------

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY assets_member_all ON assets FOR ALL
  USING (org_id = current_org_id() AND is_org_member(org_id))
  WITH CHECK (org_id = current_org_id() AND is_org_member(org_id));

-- IMPORTANT: microsites are public-facing.
-- The /[slug] page reads via service role, NOT user JWT.
-- Public microsite endpoint uses anon key + slug parameter, NOT RLS.

ALTER TABLE outreach_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY outreach_events_member_select ON outreach_events FOR SELECT
  USING (org_id = current_org_id() AND is_org_member(org_id));

-- Inserts via service role (workers)

ALTER TABLE tracking_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tracking_events_member_select ON tracking_events FOR SELECT
  USING (org_id = current_org_id() AND is_org_member(org_id));

-- Inserts via service role (tracking pixel endpoint runs as service)

-- ---------------------------------------------------------------------
-- GIFTING TABLES
-- ---------------------------------------------------------------------

ALTER TABLE gifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY gifts_member_all ON gifts FOR ALL
  USING (org_id = current_org_id() AND is_org_member(org_id))
  WITH CHECK (org_id = current_org_id() AND is_org_member(org_id));

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY approval_requests_member_all ON approval_requests FOR ALL
  USING (org_id = current_org_id() AND is_org_member(org_id))
  WITH CHECK (org_id = current_org_id() AND is_org_member(org_id));

-- ---------------------------------------------------------------------
-- CONCIERGE TABLES
-- ---------------------------------------------------------------------

ALTER TABLE concierge_threads ENABLE ROW LEVEL SECURITY;

-- Members see threads of their own org. Each user sees only their own iMessage history
-- within that org (cofounders don't snoop on each other's iMessage).
CREATE POLICY concierge_threads_self_select ON concierge_threads FOR SELECT
  USING (
    org_id = current_org_id()
    AND user_id = current_user_id()
    AND is_org_member(org_id)
  );

-- Inserts via service role (Sendblue webhook handler runs as service)

ALTER TABLE concierge_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY concierge_memory_self_select ON concierge_memory FOR SELECT
  USING (
    org_id = current_org_id()
    AND user_id = current_user_id()
    AND is_org_member(org_id)
  );

-- =====================================================================
-- SECTION 3: trigger to auto-update updated_at columns
-- =====================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Apply to every table with updated_at column
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'updated_at'
      AND table_schema = 'public'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();',
      t, t
    );
  END LOOP;
END $$;

-- =====================================================================
-- SECTION 4: bootstrap an org for a newly signed-up user
-- =====================================================================

-- Called from API after Supabase Auth signup.
-- Creates org + user + org_member in one transaction.
CREATE OR REPLACE FUNCTION public.bootstrap_user_org(
  p_supabase_auth_id uuid,
  p_email text,
  p_name text,
  p_org_name text,
  p_org_slug text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_user_id uuid;
  new_org_id uuid;
BEGIN
  -- Create user
  INSERT INTO users (supabase_auth_id, email, name)
  VALUES (p_supabase_auth_id, p_email, p_name)
  RETURNING id INTO new_user_id;

  -- Create org
  INSERT INTO orgs (name, slug)
  VALUES (p_org_name, p_org_slug)
  RETURNING id INTO new_org_id;

  -- Link as owner
  INSERT INTO org_members (org_id, user_id, role)
  VALUES (new_org_id, new_user_id, 'owner');

  -- Seed default agents (instances of templates)
  INSERT INTO org_agents (org_id, template_id, kind, enabled)
  SELECT new_org_id, id, kind, true
  FROM agent_templates
  WHERE version = '0.1';

  RETURN new_org_id;
END;
$$;

-- =====================================================================
-- SECTION 5: NOTES on service role usage
-- =====================================================================
--
-- Service role bypasses RLS. Use it ONLY in:
--   - Background workers (BullMQ jobs running on Railway)
--   - Webhooks from external services (Sendblue, Stripe, Apify)
--   - Public microsite renderer (reads asset by slug, no auth)
--
-- Service role MUST always:
--   1. Receive org_id from job payload, never derive it from anywhere else
--   2. Filter every query by that org_id explicitly (defense in depth)
--   3. Never expose service role key to frontend code
--
-- Frontend (Next.js client components, microsite pages) uses ANON key only.
-- Backend tRPC routes that act on user behalf use the user's JWT, RLS enforces.
-- =====================================================================
