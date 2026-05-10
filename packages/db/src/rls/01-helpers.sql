-- =====================================================================
-- RLS helper functions.
-- Idempotent via CREATE OR REPLACE.
--
-- SECURITY DEFINER on functions that query auxiliary tables (users, org_members).
-- Without it, the function inherits the caller's RLS context and recursively
-- triggers its own policies — e.g., is_org_member SELECTs from org_members,
-- which has a policy that calls is_org_member → infinite recursion → Postgres
-- aborts with NULL.
--
-- SET search_path = '' enforces fully-qualified references (public.users,
-- auth.uid()) to prevent search_path injection in a SECURITY DEFINER context.
-- =====================================================================

-- Returns the org_id from the JWT claim. NULL if not authenticated or no org context.
-- No table access, so plain STABLE is enough. The Custom Access Token Hook
-- (03-access-token-hook.sql) injects this claim.
CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::json ->> 'org_id',
    ''
  )::uuid;
$$;

-- Returns the application user_id of the currently authenticated user.
-- Maps from auth.users.id (Supabase Auth) to public.users.id (our schema).
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS uuid
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT id FROM public.users WHERE supabase_auth_id = auth.uid();
$$;

-- Returns true if the current authenticated user is a member of the given org.
-- Cross-checks the JWT against actual org_members rows. Defends against forged
-- JWTs: even if an attacker claims org_id=X, this returns false unless they
-- actually have a row in org_members for that org.
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

-- Returns true if the current authenticated user has owner role in the given org.
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
