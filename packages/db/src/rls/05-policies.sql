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

-- ---------------------------------------------------------------------
-- icps (Sprint 2)
-- ---------------------------------------------------------------------
ALTER TABLE public.icps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS icps_member_all ON public.icps;
CREATE POLICY icps_member_all ON public.icps
  FOR ALL
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id))
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_member(org_id));

-- ---------------------------------------------------------------------
-- leads (Sprint 2)
-- ---------------------------------------------------------------------
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leads_member_all ON public.leads;
CREATE POLICY leads_member_all ON public.leads
  FOR ALL
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id))
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_member(org_id));

-- ---------------------------------------------------------------------
-- lead_dossiers (Sprint 2)
-- ---------------------------------------------------------------------
ALTER TABLE public.lead_dossiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_dossiers_member_all ON public.lead_dossiers;
CREATE POLICY lead_dossiers_member_all ON public.lead_dossiers
  FOR ALL
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id))
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_member(org_id));

-- ---------------------------------------------------------------------
-- lead_threads (Sprint 2) — append-only audit log per lead
-- ---------------------------------------------------------------------
ALTER TABLE public.lead_threads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_threads_member_select ON public.lead_threads;
CREATE POLICY lead_threads_member_select ON public.lead_threads
  FOR SELECT
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id));

DROP POLICY IF EXISTS lead_threads_member_insert ON public.lead_threads;
CREATE POLICY lead_threads_member_insert ON public.lead_threads
  FOR INSERT
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_member(org_id));

-- No UPDATE/DELETE policies on lead_threads — append-only audit log.
-- GDPR scrub uses service role + hard delete + audit_logs entry.

-- ---------------------------------------------------------------------
-- tool_call_logs (Sprint 3) — every agent tool invocation
-- Members SELECT their org's logs; service role INSERTs (no member writes).
-- ---------------------------------------------------------------------
ALTER TABLE public.tool_call_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tool_call_logs_member_select ON public.tool_call_logs;
CREATE POLICY tool_call_logs_member_select ON public.tool_call_logs
  FOR SELECT
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id));

-- No INSERT/UPDATE/DELETE policies on tool_call_logs.
-- Service role inserts via defineTool's audit wrapper; users never mutate.

-- =====================================================================
-- Sprint 4 — outreach pipeline (assets, outreach_events, tracking_events)
-- =====================================================================

-- ---------------------------------------------------------------------
-- assets — founder full CRUD on drafts and published assets.
-- Soft-delete via UPDATE deleted_at (no hard DELETE in normal flow, but
-- member DELETE policy is present for explicit purge by founder).
-- ---------------------------------------------------------------------
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assets_member_select ON public.assets;
CREATE POLICY assets_member_select ON public.assets
  FOR SELECT
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id));

DROP POLICY IF EXISTS assets_member_insert ON public.assets;
CREATE POLICY assets_member_insert ON public.assets
  FOR INSERT
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_member(org_id));

DROP POLICY IF EXISTS assets_member_update ON public.assets;
CREATE POLICY assets_member_update ON public.assets
  FOR UPDATE
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id))
  WITH CHECK (org_id = public.current_org_id() AND public.is_org_member(org_id));

DROP POLICY IF EXISTS assets_member_delete ON public.assets;
CREATE POLICY assets_member_delete ON public.assets
  FOR DELETE
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id));

-- ---------------------------------------------------------------------
-- outreach_events — state-on-row mutable, but immutable from member view.
-- Member SELECT only. Service role performs INSERT (initial send) and
-- UPDATE (webhook status transitions).
-- ---------------------------------------------------------------------
ALTER TABLE public.outreach_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outreach_events_member_select ON public.outreach_events;
CREATE POLICY outreach_events_member_select ON public.outreach_events
  FOR SELECT
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id));

-- No INSERT/UPDATE/DELETE policies on outreach_events.
-- Workers + webhook handlers run as service role (bypasses RLS).

-- ---------------------------------------------------------------------
-- tracking_events — append-only pixel hit stream.
-- Member SELECT only. Service role performs INSERT (ingest endpoint).
-- ---------------------------------------------------------------------
ALTER TABLE public.tracking_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tracking_events_member_select ON public.tracking_events;
CREATE POLICY tracking_events_member_select ON public.tracking_events
  FOR SELECT
  USING (org_id = public.current_org_id() AND public.is_org_member(org_id));

-- No INSERT/UPDATE/DELETE policies on tracking_events.
-- Public microsite ingest endpoint (Sprint 7) runs as service role.

-- =====================================================================
-- Enum documentation (informational, not enforced at DB level)
-- =====================================================================

COMMENT ON TYPE public.lead_status IS
  'Lead lifecycle states. Valid transitions (informational, enforced at app layer):
   discovered -> enriching -> enriched -> composing -> composed -> engaged.
   engaged -> tracking <-> tracking_paused_human <-> booked.
   tracking -> gift_pending -> tracking (gift cycle).
   any state -> lost (founder mark or auto-breakup after no reply).';
