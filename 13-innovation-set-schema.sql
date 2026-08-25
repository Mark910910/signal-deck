-- ============================================================================
-- FEATURES: four ideas from the ui-designer/usability-expert innovation
-- passes that need schema support, bundled into one migration since
-- they're small, independent, additive changes touching different tables.
-- ----------------------------------------------------------------------------
-- 1. "Try it as a customer" — a brand-new, non-technical org owner has no
--    way to see the portal actually work without leaving the app and
--    guessing. One button arms a short-lived window on the org; the next
--    real submission through that org's own portal link within that
--    window is tagged is_practice, so it's never mistaken for a real
--    customer report anywhere it surfaces (Deck, IncidentList, exports).
--
-- 2. Ambient per-incident cost — an optional org-level hourly rate,
--    multiplied client-side against time already logged via
--    TimeSpentPanel. Blank by default; nothing renders differently for
--    an org that never sets it.
--
-- 3. Vendor RFQ SLA urgency — when a quote request is linked to an
--    incident (quote_requests.incident_id, already existed), the
--    vendor-facing RPC now also returns that incident's severity/SLA
--    context, translated into something a vendor with zero ITSM context
--    can read, kept deliberately coarse (a plain-language window, never
--    an exact countdown) so it can't become negotiating leverage.
--
-- 4. TrackPage "honest ETA" — a real, computed median of the org's own
--    past resolution times for the same category+severity, never a
--    marketed SLA promise. Requires at least 5 historical samples to
--    render at all; silently omits itself otherwise rather than showing
--    fake precision on a brand-new org or a rare category.
-- ============================================================================

ALTER TABLE public.organisations ADD COLUMN IF NOT EXISTS hourly_rate numeric;
ALTER TABLE public.organisations ADD COLUMN IF NOT EXISTS practice_armed_until timestamptz;
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS is_practice boolean NOT NULL DEFAULT false;

-- Staff-only, authenticated — arms this org's own portal for one practice
-- run. Deliberately short (15 min): long enough for someone to switch
-- tabs and submit once, short enough that it can't linger and mislabel a
-- real submission hours later.
CREATE OR REPLACE FUNCTION public.arm_portal_practice_mode()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  update organisations set practice_armed_until = now() + interval '15 minutes' where id = current_org_id();
end;
$function$;

-- submit_via_portal: tag is_practice when the arming window is live for
-- this org, exactly like the existing shown_articles parameter this
-- function already handles — no new argument needed, this is derived
-- entirely server-side from organisations.practice_armed_until so an
-- anonymous caller can't self-declare a submission "practice" and dodge
-- a real customer flow being tagged as ignorable.
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
  is_practice_run boolean;
begin
  select id, (practice_armed_until is not null and practice_armed_until > now())
    into target_org_id, is_practice_run
    from organisations where portal_slug = slug;
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

  if shown_articles is null or jsonb_typeof(shown_articles) <> 'array' then
    shown_articles := '[]'::jsonb;
  end if;

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

  insert into incidents (org_id, display_id, title, notes, category_id, severity_id, status_id, sla_minutes, source, deflection_context, is_practice)
  select target_org_id, new_display_id, incident_title, incident_notes, matched_category_id, fallback_severity_id,
         fallback_status_id, sla_minutes, 'portal',
         case when jsonb_array_length(coalesce(capped_articles, '[]'::jsonb)) > 0 then capped_articles else null end,
         coalesce(is_practice_run, false)
  from severities where id = fallback_severity_id
  returning id into new_incident_id;

  insert into incident_timeline (incident_id, org_id, status_id, note)
  values (new_incident_id, target_org_id, fallback_status_id, case when is_practice_run then 'Submitted via self-service portal (practice run)' else 'Submitted via self-service portal' end);

  insert into incident_customer_access (incident_id, org_id) values (new_incident_id, target_org_id)
  returning token into new_token;

  return query select new_display_id, new_token;
end;
$function$;

-- get_quote_request_for_vendor: adding trailing columns to a RETURNS
-- TABLE list changes the function's return type, which Postgres does not
-- allow via CREATE OR REPLACE (only the argument list can grow with a
-- default — this is the same class of mistake as the earlier
-- submit_via_portal overload bug, just on the return side instead of the
-- argument side, caught this time by migration-reviewer before applying
-- rather than after). Explicit DROP first, then create fresh — existing
-- callers all read by column name via PostgREST/supabase-js, never
-- positionally, so this is safe for them. Deliberately coarse — a
-- category label and an hour count, never the incident's own title,
-- customer detail, or an exact countdown.
DROP FUNCTION IF EXISTS public.get_quote_request_for_vendor(text);

CREATE OR REPLACE FUNCTION public.get_quote_request_for_vendor(track_token text)
 RETURNS TABLE(display_id text, description text, vendor_name text, quoted_price numeric, notes text, valid_until date, submitted_at timestamp with time zone, linked_incident_severity text, linked_incident_sla_minutes integer, linked_incident_created_at timestamp with time zone, linked_incident_resolved_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select qr.display_id, qr.description, v.name, qrv.quoted_price, qrv.notes, qrv.valid_until, qrv.submitted_at,
    sev.name, i.sla_minutes, i.created_at, i.resolved_at
  from quote_request_vendors qrv
  join quote_requests qr on qr.id = qrv.quote_request_id
  join vendors v on v.id = qrv.vendor_id
  left join incidents i on i.id = qr.incident_id
  left join severities sev on sev.id = i.severity_id
  where qrv.token = track_token;
$function$;

-- Honest ETA — a real median (percentile_cont, not a naive average that a
-- single slow outlier would skew), scoped to the SAME org+category+
-- severity as the incident behind this token, over the trailing year.
-- Returns nothing at all below a 5-sample floor rather than a number
-- with no real basis — TrackPage treats a null/empty result as "don't
-- show this line," never as "0 hours."
CREATE OR REPLACE FUNCTION public.get_typical_resolution_for_customer(track_token text)
 RETURNS TABLE(typical_hours numeric, sample_size bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  target_incident record;
begin
  select i.org_id, i.category_id, i.severity_id into target_incident
  from incidents i
  join incident_customer_access a on a.incident_id = i.id
  where a.token = track_token;

  if target_incident is null then
    return;
  end if;

  return query
  select
    round((percentile_cont(0.5) within group (order by extract(epoch from (resolved_at - created_at))) / 3600)::numeric, 1),
    count(*)
  from incidents
  where org_id = target_incident.org_id
    and category_id = target_incident.category_id
    and severity_id = target_incident.severity_id
    and resolved_at is not null
    and created_at > now() - interval '365 days'
  having count(*) >= 5;
end;
$function$;
