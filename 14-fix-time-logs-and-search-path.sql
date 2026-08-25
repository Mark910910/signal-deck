-- ============================================================================
-- FIXES, from live-testing production after the innovation-set ship:
--
-- 1. incident_time_logs never existed. TimeSpentPanel (IncidentDetail's
--    manual "Log time" feature) has been reading/writing this table since
--    before today's work, but the table itself was never migrated — every
--    load/add/remove has been silently 404ing in production, with no error
--    surfaced to the user. Adding it now, mirroring incident_timeline's own
--    shape/RLS pattern exactly (org-scoped, single ALL policy keyed off
--    current_org_id()).
--
-- 2. All four of today's new SECURITY DEFINER functions were flagged by the
--    security advisor for a mutable search_path — the same gap already
--    exists on every other SECURITY DEFINER function in this project (none
--    of them set one), so this isn't a regression, but it's a real,
--    essentially-free hardening step: pinning search_path stops a
--    SECURITY DEFINER function from being tricked into resolving an
--    unqualified name against a schema an attacker controls. Using
--    ALTER FUNCTION ... SET, not CREATE OR REPLACE, so there's zero chance
--    of touching the actual function bodies.
-- ============================================================================

CREATE TABLE public.incident_time_logs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id),
  minutes integer NOT NULL,
  note text,
  logged_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incident_time_logs_incident_id_idx ON public.incident_time_logs USING btree (incident_id);

ALTER TABLE public.incident_time_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation_all ON public.incident_time_logs
  FOR ALL USING (org_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.incident_time_logs TO anon, authenticated, service_role;

ALTER FUNCTION public.arm_portal_practice_mode() SET search_path = public;
ALTER FUNCTION public.submit_via_portal(text, text, text, text, jsonb) SET search_path = public;
ALTER FUNCTION public.get_quote_request_for_vendor(text) SET search_path = public;
ALTER FUNCTION public.get_typical_resolution_for_customer(text) SET search_path = public;
