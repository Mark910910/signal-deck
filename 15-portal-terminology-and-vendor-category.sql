-- ============================================================================
-- Follow-up from the QA + ui-designer/usability-expert review pass:
--
-- 1. Portal/Track pages never applied a template's terminology at all —
--    every customer saw generic "Report an issue"/"Track your issue"
--    copy regardless of org, while the category dropdown one field below
--    correctly showed org-specific options. effective_terminology()
--    already does the exact merge these two anonymous, org-row-less
--    pages need — they just never had a way to call it. One new tiny RPC
--    for PortalPage (keyed only by slug, no org row available at all),
--    one extra column on get_incident_status_for_customer for TrackPage
--    (it already resolves an org via incident_customer_access, just
--    needs to select it). Same drop+recreate-for-return-type-change
--    pattern already used for get_quote_request_for_vendor in
--    13-innovation-set-schema.sql.
--
-- 2. Vendor & Procurement Management's only org ("Elijah") has no
--    category that fits a service failure (a cleaning contractor
--    no-show, etc.) — every existing option presumes a physical
--    shipment. This is plain per-org seed data — categories has no
--    template-level default list anywhere in this codebase — so it's a
--    one-row insert, not a schema change.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.portal_org_terminology(slug text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path = public
AS $function$
  select effective_terminology(o.id) from organisations o where o.portal_slug = slug;
$function$;

DROP FUNCTION IF EXISTS public.get_incident_status_for_customer(text);

CREATE OR REPLACE FUNCTION public.get_incident_status_for_customer(track_token text)
 RETURNS TABLE(display_id text, title text, status_name text, created_at timestamptz, resolved_at timestamptz, can_reopen boolean, terminology jsonb)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path = public
AS $function$
  select i.display_id, i.title, st.name, i.created_at, i.resolved_at,
    (i.resolved_at is not null and i.resolved_at > now() - interval '14 days'),
    effective_terminology(a.org_id)
  from incidents i
  join incident_customer_access a on a.incident_id = i.id
  left join statuses st on st.id = i.status_id
  where a.token = track_token;
$function$;

INSERT INTO public.categories (org_id, name)
SELECT 'd43a9fd7-a386-4a3a-adb1-82ec5c718265', 'Service Failure / No-show'
WHERE NOT EXISTS (
  SELECT 1 FROM public.categories WHERE org_id = 'd43a9fd7-a386-4a3a-adb1-82ec5c718265' AND name = 'Service Failure / No-show'
);
