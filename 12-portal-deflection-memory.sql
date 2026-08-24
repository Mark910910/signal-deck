-- ============================================================================
-- FEATURE: "deflection memory" — carry what a customer already saw and
-- rejected forward into the incident it still resulted in
-- ----------------------------------------------------------------------------
-- record_kb_shown/log_kb_feedback already track, per portal session, which
-- KB articles were surfaced and how they were rated — but that data only
-- ever rolls up into an org-wide aggregate on KBArticlesPanel. It never
-- travels with the specific incident that resulted from a failed
-- deflection attempt, so an agent has no way to avoid re-suggesting the
-- exact article the customer already read and rejected minutes ago — a
-- well-documented, common support complaint.
--
-- This is a staff-only, passive note, not a customer-facing feature: the
-- customer does nothing differently and sees nothing new. Snapshotted as
-- {title, was_helpful} at submission time rather than a live FK join —
-- matches how notes/audit entries elsewhere in this schema store text
-- snapshots rather than requiring the article to still exist unmodified
-- later.
--
-- Reviewed by migration-reviewer before this version, which caught two
-- real bugs in the first draft, both fixed below:
--
-- 1. CREATE OR REPLACE with a changed argument list does NOT replace a
--    function in Postgres — it creates a second, permanent overload
--    alongside the untouched original (Postgres identifies functions by
--    name + argument TYPES, and (text,text,text,text) is a different
--    identity than (text,text,text,text,jsonb)). Any exact-4-argument
--    caller would keep silently binding to the stale original forever.
--    Fixed: explicit DROP FUNCTION of the old 4-arg signature first, so
--    there is exactly one submit_via_portal, and existing 4-named-argument
--    calls correctly resolve to this one using its default for the new
--    parameter — an actual replace, not a shadow.
--
-- 2. The capping logic threw an unhandled exception (and aborted incident
--    creation entirely) on any non-array shown_articles — a JSON `null`
--    literal, a string, a number, or an object all raised "cannot extract
--    elements from a scalar/object". Since this parameter is reachable by
--    anonymous, unauthenticated portal visitors (not just the vetted
--    PortalPage.jsx frontend), a slightly different direct API call could
--    have broken the core incident-submission path entirely for a feature
--    that's supposed to be purely passive. Fixed: shown_articles is
--    normalized to '[]'::jsonb up front whenever it isn't SQL NULL and
--    isn't a genuine JSON array, before anything tries to iterate it.
--
-- Also addressed, flagged but not required to block: capping only bounded
-- array LENGTH, not each element's shape or content — nothing stopped an
-- anonymous caller from sending arbitrary free text (not an actual KB
-- title) straight into deflection_context with no redact_pii() pass,
-- unlike every other customer-text-adjacent write in this schema
-- (submit_quote_response, reopen_incident_via_token, etc.). Fixed by
-- rebuilding each element explicitly (only ever a title string, redacted
-- and length-capped, plus a strictly-boolean-or-null was_helpful) rather
-- than storing whatever shape the caller happened to send.
-- ============================================================================

ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS deflection_context jsonb;

DROP FUNCTION IF EXISTS public.submit_via_portal(text, text, text, text);

CREATE OR REPLACE FUNCTION public.submit_via_portal(slug text, incident_title text, incident_notes text, category_name text, shown_articles jsonb DEFAULT '[]'::jsonb)
 RETURNS TABLE(display_id text, track_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  target_org_id uuid;
  matched_category_id uuid;
  fallback_severity_id uuid;
  fallback_status_id uuid;
  new_display_id text;
  new_incident_id uuid;
  new_token text;
  capped_articles jsonb;
begin
  select id into target_org_id from organisations where portal_slug = slug;
  if target_org_id is null then
    raise exception 'Invalid portal link.';
  end if;

  select id into matched_category_id from categories where org_id = target_org_id and name = category_name;
  if matched_category_id is null then
    select id into matched_category_id from categories where org_id = target_org_id order by name limit 1;
  end if;

  select id into fallback_severity_id from severities where org_id = target_org_id and name = 'Medium';
  if fallback_severity_id is null then
    select id into fallback_severity_id from severities where org_id = target_org_id order by sla_minutes limit 1;
  end if;

  select id into fallback_status_id from statuses where org_id = target_org_id order by sort_order limit 1;

  new_display_id := 'INC-' || extract(year from now()) || '-' || floor(random() * 9000 + 1000)::text;

  -- Normalize first: SQL NULL, JSON null, a string, a number, or an object
  -- are all treated as "nothing was shown" rather than raising — this
  -- parameter comes from an anonymous, unauthenticated caller, so malformed
  -- input has to degrade gracefully, never abort incident creation itself.
  if shown_articles is null or jsonb_typeof(shown_articles) <> 'array' then
    shown_articles := '[]'::jsonb;
  end if;

  -- Rebuild each element explicitly rather than trusting the caller's
  -- shape/content — only a redacted, length-capped title and a strict
  -- boolean-or-null survive. Non-object array entries are dropped rather
  -- than stored as junk. Capped at 5 — bounding attacker-controlled input,
  -- not a meaningful business number.
  select jsonb_agg(
    jsonb_build_object(
      'title', redact_pii(left(coalesce(elem->>'title', ''), 200)),
      'was_helpful', case elem->>'was_helpful' when 'true' then true when 'false' then false else null end
    )
  ) into capped_articles
  from (
    select elem from jsonb_array_elements(shown_articles) with ordinality as t(elem, ord)
    where jsonb_typeof(elem) = 'object'
    order by ord limit 5
  ) sub;

  insert into incidents (org_id, display_id, title, notes, category_id, severity_id, status_id, sla_minutes, source, deflection_context)
  select target_org_id, new_display_id, incident_title, incident_notes, matched_category_id, fallback_severity_id,
         fallback_status_id, sla_minutes, 'portal',
         case when jsonb_array_length(coalesce(capped_articles, '[]'::jsonb)) > 0 then capped_articles else null end
  from severities where id = fallback_severity_id
  returning id into new_incident_id;

  insert into incident_timeline (incident_id, org_id, status_id, note)
  values (new_incident_id, target_org_id, fallback_status_id, 'Submitted via self-service portal');

  insert into incident_customer_access (incident_id, org_id) values (new_incident_id, target_org_id)
  returning token into new_token;

  return query select new_display_id, new_token;
end;
$function$;
