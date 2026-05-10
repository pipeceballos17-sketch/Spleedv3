-- =====================================================================
-- RLS policies for Sprint 1 tables.
-- Idempotent: DROP POLICY IF EXISTS before each CREATE.
--
-- All policies use a "defense in depth" pattern: org_id = current_org_id() (JWT
-- claim) AND is_org_member(org_id) (cross-check against org_members). If an
-- attacker forges a JWT with a different org_id, is_org_member rejects them
-- because their user is not actually a member of that org.
-- =====================================================================

-- ---------------------------------------------------------------------
-- orgs
-- ---------------------------------------------------------------------
ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orgs_member_select ON public.orgs;
CREATE POLICY orgs_member_select ON public.orgs
  FOR SELECT USING (public.is_org_member(id));

DROP POLICY IF EXISTS orgs_owner_update ON public.orgs;
CREATE POLICY orgs_owner_update ON public.orgs
  FOR UPDATE
  USING (public.is_org_owner(id))
  WITH CHECK (public.is_org_owner(id));

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_self_select ON public.users;
CREATE POLICY users_self_select ON public.users
  FOR SELECT USING (supabase_auth_id = auth.uid());

DROP POLICY IF EXISTS users_self_update ON public.users;
CREATE POLICY users_self_update ON public.users
  FOR UPDATE
  USING (supabase_auth_id = auth.uid())
  WITH CHECK (supabase_auth_id = auth.uid());

-- ---------------------------------------------------------------------
-- org_members
-- ---------------------------------------------------------------------
ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_members_member_select ON public.org_members;
CREATE POLICY org_members_member_select ON public.org_members
  FOR SELECT USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS org_members_owner_modify ON public.org_members;
CREATE POLICY org_members_owner_modify ON public.org_members
  FOR ALL
  USING (public.is_org_owner(org_id))
  WITH CHECK (public.is_org_owner(org_id));

-- ---------------------------------------------------------------------
-- org_integrations
-- ---------------------------------------------------------------------
ALTER TABLE public.org_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_integrations_member_select ON public.org_integrations;
CREATE POLICY org_integrations_member_select ON public.org_integrations
  FOR SELECT
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id));

DROP POLICY IF EXISTS org_integrations_owner_modify ON public.org_integrations;
CREATE POLICY org_integrations_owner_modify ON public.org_integrations
  FOR ALL
  USING (org_id = public.current_org_id() AND public.is_org_owner(org_id))
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_owner(org_id));

-- ---------------------------------------------------------------------
-- agent_templates (system-wide read-only reference)
-- ---------------------------------------------------------------------
ALTER TABLE public.agent_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_templates_authenticated_select ON public.agent_templates;
CREATE POLICY agent_templates_authenticated_select ON public.agent_templates
  FOR SELECT USING (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------
-- org_agents
-- ---------------------------------------------------------------------
ALTER TABLE public.org_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_agents_member_all ON public.org_agents;
CREATE POLICY org_agents_member_all ON public.org_agents
  FOR ALL
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id))
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_member(org_id));

-- ---------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_member_select ON public.audit_logs;
CREATE POLICY audit_logs_member_select ON public.audit_logs
  FOR SELECT
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id));

-- No INSERT/UPDATE/DELETE policies on audit_logs.
-- Service role inserts; users never mutate audit history directly.
