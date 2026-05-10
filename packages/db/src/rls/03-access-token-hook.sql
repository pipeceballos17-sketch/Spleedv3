-- =====================================================================
-- Custom Access Token Hook (Decision 1 + 3)
--
-- Injects org_id and org_role into JWT claims when Supabase Auth issues an
-- access token. Single-org MVP: takes the user's first org_members row by
-- created_at ASC (stable across logins).
--
-- The function alone does nothing — it must be enabled via Supabase config:
--   - LOCAL: supabase/config.toml [auth.hook.custom_access_token]
--   - HOSTED: Dashboard → Authentication → Hooks → Customize Access Token (CAT)
-- See docs/runbook/supabase-setup.md for the manual step.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claims jsonb;
  org_record record;
  auth_user_id uuid;
BEGIN
  claims := event->'claims';
  auth_user_id := (event->>'user_id')::uuid;

  SELECT om.org_id, om.role INTO org_record
  FROM public.users u
  INNER JOIN public.org_members om ON om.user_id = u.id
  WHERE u.supabase_auth_id = auth_user_id
  ORDER BY om.created_at ASC
  LIMIT 1;

  IF org_record.org_id IS NOT NULL THEN
    claims := jsonb_set(claims, '{org_id}', to_jsonb(org_record.org_id::text));
    claims := jsonb_set(claims, '{org_role}', to_jsonb(org_record.role::text));
  END IF;

  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated, anon, public;

-- The hook needs read access to look up org membership.
GRANT SELECT ON public.users TO supabase_auth_admin;
GRANT SELECT ON public.org_members TO supabase_auth_admin;
