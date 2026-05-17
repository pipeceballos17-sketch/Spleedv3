-- =====================================================================
-- Vault helpers for per-org integration secrets (Sprint 3).
--
-- Sprint 1 created `org_integrations.vault_secret_id` (text); Sprint 3 wires
-- the read/write/revoke flow that agents (Sprint 5+) and workers use to obtain
-- per-tenant credentials (Apollo, Gmail, Sendblue, Stripe Issuing, etc.).
--
-- All functions are SECURITY DEFINER with `search_path = ''` (so references
-- like `vault.secrets`, `public.org_integrations`, and `auth.uid()` must be
-- fully qualified) and EXECUTE granted to service_role only. Workers call them
-- via Drizzle raw SQL with the service role connection.
--
-- IMPORTANT: verify before applying. Run:
--   docker exec supabase_db_spleed psql -U postgres -d postgres -c "\df vault.*"
-- Expect: vault.create_secret(text, text, text) returning uuid, and a view
-- vault.decrypted_secrets with columns (id uuid, decrypted_secret text, …).
-- If signatures changed, adjust the calls below.
-- =====================================================================

-- ---------------------------------------------------------------------
-- set_org_integration_secret(p_org_id, p_kind, p_secret, p_account?, p_metadata?)
--   Creates a new Vault entry on first set, updates the existing one on subsequent
--   sets. Always marks status='connected' and clears last_error_message.
--   Returns org_integrations.id.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_org_integration_secret(
  p_org_id uuid,
  p_kind public.integration_kind,
  p_secret text,
  p_account_identifier text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing_secret_id text;
  v_integration_id uuid;
  v_new_secret_uuid uuid;
BEGIN
  SELECT id, vault_secret_id INTO v_integration_id, v_existing_secret_id
  FROM public.org_integrations
  WHERE org_id = p_org_id AND kind = p_kind;

  IF v_existing_secret_id IS NOT NULL AND v_existing_secret_id <> '' THEN
    UPDATE vault.secrets
    SET secret = p_secret, updated_at = now()
    WHERE id = v_existing_secret_id::uuid;

    UPDATE public.org_integrations
    SET account_identifier = COALESCE(p_account_identifier, account_identifier),
        metadata = p_metadata,
        status = 'connected',
        last_validated_at = now(),
        last_error_message = NULL,
        updated_at = now()
    WHERE id = v_integration_id;

    RETURN v_integration_id;
  ELSE
    SELECT vault.create_secret(
      p_secret,
      format('org_%s_%s', p_org_id, p_kind),
      format('Integration %s for org %s', p_kind, p_org_id)
    ) INTO v_new_secret_uuid;

    INSERT INTO public.org_integrations
      (org_id, kind, vault_secret_id, account_identifier, metadata, status, last_validated_at)
    VALUES
      (p_org_id, p_kind, v_new_secret_uuid::text, p_account_identifier, p_metadata, 'connected', now())
    RETURNING id INTO v_integration_id;

    RETURN v_integration_id;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- get_org_integration_secret(p_org_id, p_kind)
--   Returns the decrypted secret if the integration is `connected`, else NULL.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_org_integration_secret(
  p_org_id uuid,
  p_kind public.integration_kind
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret text;
BEGIN
  SELECT ds.decrypted_secret INTO v_secret
  FROM public.org_integrations oi
  INNER JOIN vault.decrypted_secrets ds ON ds.id = oi.vault_secret_id::uuid
  WHERE oi.org_id = p_org_id
    AND oi.kind = p_kind
    AND oi.status = 'connected';
  RETURN v_secret;
END;
$$;

-- ---------------------------------------------------------------------
-- revoke_org_integration_secret(p_org_id, p_kind)
--   Hard-deletes the Vault entry and marks the integration disconnected.
--   Returns true if a secret was revoked, false if there was nothing to revoke.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_org_integration_secret(
  p_org_id uuid,
  p_kind public.integration_kind
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret_id text;
BEGIN
  SELECT vault_secret_id INTO v_secret_id
  FROM public.org_integrations
  WHERE org_id = p_org_id AND kind = p_kind;

  IF v_secret_id IS NULL OR v_secret_id = '' THEN
    RETURN false;
  END IF;

  DELETE FROM vault.secrets WHERE id = v_secret_id::uuid;

  UPDATE public.org_integrations
  SET status = 'disconnected',
      vault_secret_id = '',
      updated_at = now()
  WHERE org_id = p_org_id AND kind = p_kind;

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------
-- Permissions: service_role only. authenticated and anon must never call these.
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.set_org_integration_secret(uuid, public.integration_kind, text, text, jsonb)
  FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.get_org_integration_secret(uuid, public.integration_kind)
  FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.revoke_org_integration_secret(uuid, public.integration_kind)
  FROM authenticated, anon, public;

GRANT EXECUTE ON FUNCTION public.set_org_integration_secret(uuid, public.integration_kind, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_org_integration_secret(uuid, public.integration_kind)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_org_integration_secret(uuid, public.integration_kind)
  TO service_role;
