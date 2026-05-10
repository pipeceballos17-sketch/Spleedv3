-- =====================================================================
-- bootstrap_user_org: called from API after Supabase Auth signup.
--
-- Creates user + org + owner membership + seeds org_agents from agent_templates,
-- all in a single transaction. SECURITY DEFINER bypasses RLS so a freshly
-- signed-up user (with no JWT org_id yet) can create their first row.
--
-- Idempotent on (supabase_auth_id): if the user already exists, reuses their id
-- and creates a new org bound to them. (Will only matter when we move beyond
-- single-org MVP.)
-- =====================================================================

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
SET search_path = public
AS $$
DECLARE
  new_user_id uuid;
  new_org_id uuid;
BEGIN
  SELECT id INTO new_user_id
  FROM public.users
  WHERE supabase_auth_id = p_supabase_auth_id;

  IF new_user_id IS NULL THEN
    INSERT INTO public.users (supabase_auth_id, email, name)
    VALUES (p_supabase_auth_id, p_email, p_name)
    RETURNING id INTO new_user_id;
  END IF;

  INSERT INTO public.orgs (name, slug)
  VALUES (p_org_name, p_org_slug)
  RETURNING id INTO new_org_id;

  INSERT INTO public.org_members (org_id, user_id, role)
  VALUES (new_org_id, new_user_id, 'owner');

  -- Seed org_agents from version 0.1 templates (the only ones in Sprint 1).
  INSERT INTO public.org_agents (org_id, template_id, kind, enabled)
  SELECT new_org_id, at.id, at.kind, true
  FROM public.agent_templates at
  WHERE at.version = '0.1';

  RETURN new_org_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.bootstrap_user_org FROM public, anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_user_org TO authenticated, service_role;
