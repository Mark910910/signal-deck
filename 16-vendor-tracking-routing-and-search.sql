-- ============================================================================
-- Three fixes:
--
-- 1. VendorTrackPage.jsx (/vendor/<token>) has been calling three RPCs
--    that have never existed — get_incident_status_for_vendor,
--    list_vendor_visible_comments, add_vendor_comment — and the staff-side
--    "Vendor-visible" comment tab (App.jsx CommentsPanel) has been
--    silently failing every insert, since incident_comments' own CHECK
--    constraints never allowed 'vendor' for author_type or visibility.
--    The whole vendor-communication path has been dead on every layer.
--    Building it properly: extend the two CHECK constraints, add a
--    token table mirroring incident_customer_access exactly, and add the
--    three missing RPCs mirroring their customer-side equivalents.
--
-- 2. Department routing: categories.default_resolver_group_id has existed
--    since 1-schema.sql and the staff "Log Incident" form already
--    auto-routes from it — but every category in every org has it set to
--    null (nobody's ever had a UI to set it, addressed in the frontend
--    change alongside this migration), and submit_via_portal never
--    consulted it at all even where it might be set. A portal-submitted
--    ticket lands with a category but no team assignment, no matter what
--    — exactly the "which department" gap reported. Mirrors the same
--    incident_assignments insert the manual-creation path already does.
--
-- 3. search_kb_articles used plainto_tsquery, which ANDs every resulting
--    lexeme — one non-matching word (out of the ~10 a realistic customer
--    sentence produces) zeroes out the whole search. Real Postgres
--    synonym dictionaries need a file on the server's filesystem, not
--    available on hosted Supabase, so this switches to OR-of-terms
--    instead: each word is safely parsed via plainto_tsquery (never
--    throws on stray punctuation, unlike raw to_tsquery), then combined
--    with the tsquery OR operator, ranked by ts_rank so the
--    best-matching article still surfaces first.
-- ============================================================================

ALTER TABLE public.incident_comments DROP CONSTRAINT incident_comments_visibility_check;
ALTER TABLE public.incident_comments ADD CONSTRAINT incident_comments_visibility_check
  CHECK (visibility = ANY (ARRAY['internal'::text, 'customer'::text, 'vendor'::text]));

ALTER TABLE public.incident_comments DROP CONSTRAINT incident_comments_author_type_check;
ALTER TABLE public.incident_comments ADD CONSTRAINT incident_comments_author_type_check
  CHECK (author_type = ANY (ARRAY['staff'::text, 'customer'::text, 'system'::text, 'vendor'::text]));

CREATE TABLE public.incident_vendor_access (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(12), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, vendor_id)
);

CREATE INDEX incident_vendor_access_incident_id_idx ON public.incident_vendor_access USING btree (incident_id);

ALTER TABLE public.incident_vendor_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation_all ON public.incident_vendor_access
  FOR ALL USING (org_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.incident_vendor_access TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_incident_status_for_vendor(track_token text)
 RETURNS TABLE(display_id text, title text, status_name text, resolved_at timestamptz, vendor_name text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path = public
AS $function$
  select i.display_id, i.title, st.name, i.resolved_at, v.name
  from incidents i
  join incident_vendor_access a on a.incident_id = i.id
  join vendors v on v.id = a.vendor_id
  left join statuses st on st.id = i.status_id
  where a.token = track_token;
$function$;

CREATE OR REPLACE FUNCTION public.list_vendor_visible_comments(track_token text)
 RETURNS TABLE(body text, author_type text, created_at timestamptz)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path = public
AS $function$
  select c.body, c.author_type, c.created_at
  from incident_comments c
  join incident_vendor_access a on a.incident_id = c.incident_id
  where a.token = track_token and c.visibility = 'vendor'
  order by c.created_at asc;
$function$;

CREATE OR REPLACE FUNCTION public.add_vendor_comment(track_token text, comment_body text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
declare
  rec record;
begin
  select * into rec from incident_vendor_access where token = track_token;
  if rec is null then
    raise exception 'Invalid tracking link.';
  end if;
  insert into incident_comments (incident_id, org_id, author_type, visibility, body)
  values (rec.incident_id, rec.org_id, 'vendor', 'vendor', redact_pii(comment_body));
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_via_portal(slug text, incident_title text, incident_notes text, category_name text, shown_articles jsonb DEFAULT '[]'::jsonb)
 RETURNS TABLE(display_id text, track_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
declare
  target_org_id uuid;
  matched_category_id uuid;
  matched_group_id uuid;
  fallback_severity_id uuid;
  matched_sla_minutes integer;
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

  select id, default_resolver_group_id into matched_category_id, matched_group_id
    from categories where org_id = target_org_id and name = category_name;
  if matched_category_id is null then
    select id, default_resolver_group_id into matched_category_id, matched_group_id
      from categories where org_id = target_org_id order by name limit 1;
  end if;

  select id into fallback_severity_id from severities where org_id = target_org_id and name = 'Medium';
  if fallback_severity_id is null then
    select id into fallback_severity_id from severities where org_id = target_org_id order by sla_minutes limit 1;
  end if;
  select sla_minutes into matched_sla_minutes from severities where id = fallback_severity_id;

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
         fallback_status_id, matched_sla_minutes, 'portal',
         case when jsonb_array_length(coalesce(capped_articles, '[]'::jsonb)) > 0 then capped_articles else null end,
         coalesce(is_practice_run, false)
  from severities where id = fallback_severity_id
  returning id into new_incident_id;

  -- Same mechanism the manual "Log Incident" form already uses
  -- (App.jsx) — a category with a configured default team routes
  -- straight to that resolver group instead of landing unassigned with
  -- no signal of who should even pick it up.
  if matched_group_id is not null then
    insert into incident_assignments (incident_id, org_id, resolver_group_id, mode, sequence_order, sla_minutes)
    values (new_incident_id, target_org_id, matched_group_id, 'parallel', 0, matched_sla_minutes);
  end if;

  insert into incident_timeline (incident_id, org_id, status_id, note)
  values (new_incident_id, target_org_id, fallback_status_id, case when is_practice_run then 'Submitted via self-service portal (practice run)' else 'Submitted via self-service portal' end);

  insert into incident_customer_access (incident_id, org_id) values (new_incident_id, target_org_id)
  returning token into new_token;

  return query select new_display_id, new_token;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Vendor email notifications, fully wired now that incident_vendor_access
-- exists. notify_vendor_on_link() was already written correctly
-- (inserts the access row, emails the vendor their track link) but was
-- never attached to a trigger — dead code. notify_vendor_of_staff_reply()
-- and notify_vendor_of_resolution() were stubbed to safe no-ops by
-- 6-fix-vendor-notify-trigger.sql specifically "until a real vendor
-- access/token table exists" (their trigger wiring was left live and is
-- untouched here — only the bodies change).
--
-- Also found while touching these: signal-deck.derivcos.workers.dev is
-- hardcoded across notify_customer_updates, notify_vendor_of_quote_request,
-- notify_vendor_on_link, and run_escalation_check — a stale domain (the
-- deployed app is signal-deck.rougue1.workers.dev), which run_escalation_check
-- even has its own comment flagging ("Replace ... as with the other
-- automation features"). Every customer/vendor/on-call email or WhatsApp
-- link sent by this app has been pointing at a dead domain. Fixed
-- everywhere it appears, in the same pass, since three of these four
-- functions are already being touched here anyway.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.notify_vendor_on_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
declare
  v record;
  new_token text;
  pg_net_present boolean;
  sender_name text;
begin
  select exists(select 1 from pg_extension where extname = 'pg_net') into pg_net_present;
  if not pg_net_present then
    return NEW;
  end if;

  select * into v from vendors where id = NEW.vendor_id;
  if v.contact_email is null or v.contact_email = '' then
    return NEW;
  end if;

  insert into incident_vendor_access (incident_id, vendor_id, org_id)
  values (NEW.incident_id, NEW.vendor_id, NEW.org_id)
  on conflict (incident_id, vendor_id) do nothing
  returning token into new_token;

  if new_token is null then
    select token into new_token from incident_vendor_access where incident_id = NEW.incident_id and vendor_id = NEW.vendor_id;
  end if;

  select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = NEW.org_id;

  perform net.http_post(
    url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'to', v.contact_email,
      'subject', 'An issue has been raised with you',
      'body', 'Hi ' || coalesce(v.contact_name, v.name) || E',\n\nAn issue has been logged that involves ' || v.name || E'. You can view it and reply here:\nhttps://signal-deck.rougue1.workers.dev/vendor/' || new_token,
      'from_name', sender_name
    )
  );

  return NEW;
end;
$function$;

CREATE TRIGGER notify_vendor_on_link AFTER INSERT ON public.incident_vendors
  FOR EACH ROW EXECUTE FUNCTION public.notify_vendor_on_link();

CREATE OR REPLACE FUNCTION public.notify_vendor_of_staff_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
declare
  a record;
  v record;
  incident_row incidents%rowtype;
  pg_net_present boolean;
  sender_name text;
begin
  if NEW.author_type <> 'staff' or NEW.visibility <> 'vendor' then
    return NEW;
  end if;

  select exists(select 1 from pg_extension where extname = 'pg_net') into pg_net_present;
  if not pg_net_present then
    return NEW;
  end if;

  select * into a from incident_vendor_access where incident_id = NEW.incident_id limit 1;
  if a is null then
    return NEW;
  end if;

  select * into v from vendors where id = a.vendor_id;
  if v.contact_email is null or v.contact_email = '' then
    return NEW;
  end if;

  select * into incident_row from incidents where id = NEW.incident_id;
  select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = NEW.org_id;

  perform net.http_post(
    url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'to', v.contact_email,
      'subject', 'New reply on ' || incident_row.display_id,
      'body', 'Hi ' || coalesce(v.contact_name, v.name) || E',\n\nThere is a new reply on the issue involving ' || v.name || E'. You can view it and reply here:\nhttps://signal-deck.rougue1.workers.dev/vendor/' || a.token,
      'from_name', sender_name
    )
  );

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_vendor_of_resolution()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
declare
  a record;
  v record;
  pg_net_present boolean;
  sender_name text;
begin
  -- This trigger fires on every incident UPDATE, not just resolution —
  -- the transition check is what makes this safe to fire unconditionally.
  if NEW.resolved_at is null or OLD.resolved_at is not null then
    return NEW;
  end if;

  select exists(select 1 from pg_extension where extname = 'pg_net') into pg_net_present;
  if not pg_net_present then
    return NEW;
  end if;

  select * into a from incident_vendor_access where incident_id = NEW.id limit 1;
  if a is null then
    return NEW;
  end if;

  select * into v from vendors where id = a.vendor_id;
  if v.contact_email is null or v.contact_email = '' then
    return NEW;
  end if;

  select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = NEW.org_id;

  perform net.http_post(
    url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'to', v.contact_email,
      'subject', NEW.display_id || ' has been resolved',
      'body', 'Hi ' || coalesce(v.contact_name, v.name) || E',\n\n' || NEW.display_id || E' has been marked resolved. You can view it here:\nhttps://signal-deck.rougue1.workers.dev/vendor/' || a.token,
      'from_name', sender_name
    )
  );

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_vendor_of_quote_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
declare
  v record;
  qr record;
  pg_net_present boolean;
  sender_name text;
begin
  select exists(select 1 from pg_extension where extname = 'pg_net') into pg_net_present;
  if not pg_net_present then
    return NEW;
  end if;

  select * into v from vendors where id = NEW.vendor_id;
  select * into qr from quote_requests where id = NEW.quote_request_id;
  if v.contact_email is null or v.contact_email = '' then
    return NEW;
  end if;

  select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = NEW.org_id;

  perform net.http_post(
    url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'to', v.contact_email,
      'subject', 'Quote requested: ' || qr.display_id,
      'body', 'Hi ' || coalesce(v.contact_name, v.name) || E',\n\nWe would like a quote for the following:\n' || qr.description || E'\n\nSubmit your price here — no account needed:\nhttps://signal-deck.rougue1.workers.dev/quote/' || NEW.token,
      'from_name', sender_name
    )
  );

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_customer_updates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
declare
  incident_row incidents%rowtype;
  pg_net_present boolean;
  sender_name text;
  identity_row record;
  event_label text;
  track_token text;
  message_body text;
begin
  select exists(select 1 from pg_extension where extname = 'pg_net') into pg_net_present;
  if not pg_net_present then
    return coalesce(NEW, OLD);
  end if;

  if TG_TABLE_NAME = 'incident_comments' then
    if NEW.author_type <> 'staff' or NEW.visibility <> 'customer' then
      return NEW;
    end if;
    select * into incident_row from incidents where id = NEW.incident_id;
    event_label := 'New reply on ' || incident_row.display_id;
  else
    incident_row := NEW;
    if NEW.resolved_at is not null and OLD.resolved_at is null then
      event_label := incident_row.display_id || ' has been resolved';
    elsif NEW.status_id is distinct from OLD.status_id then
      event_label := incident_row.display_id || ' status updated';
    else
      return NEW;
    end if;
  end if;

  select ii.*, o.identity_module_enabled into identity_row
  from incident_identity ii
  join organisations o on o.id = incident_row.org_id
  where ii.incident_id = incident_row.id;

  if identity_row is null or not identity_row.identity_module_enabled or not identity_row.consent_given
     or identity_row.customer_contact is null or identity_row.customer_contact !~ '@' then
    return NEW;
  end if;

  select token into track_token from incident_customer_access where incident_id = incident_row.id limit 1;
  message_body := event_label || E'.\n\nSee details or reply here: https://signal-deck.rougue1.workers.dev/track/' || coalesce(track_token, '');

  select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = incident_row.org_id;
  perform net.http_post(
    url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('to', identity_row.customer_contact, 'subject', event_label, 'body', message_body, 'from_name', sender_name)
  );

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.run_escalation_check()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
declare
  policy record;
  target_incident record;
  target_email text;
  target_whatsapp text;
  ack_token text;
  ack_link text;
  message_body text;
  sender_name text;
begin
  for policy in select * from escalation_policies where active = true loop
    select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = policy.org_id;
    for target_incident in
      select i.* from incidents i
      join incident_assignments ia on ia.incident_id = i.id and ia.resolver_group_id = policy.resolver_group_id
      where i.org_id = policy.org_id and i.resolved_at is null and i.acknowledged_at is null
        and i.escalated_at is null
        and (policy.severity_id is null or i.severity_id = policy.severity_id)
        and i.created_at < now() - (policy.minutes_before_escalation || ' minutes')::interval
    loop
      select get_or_create_ack_token(target_incident.id) into ack_token;
      ack_link := 'https://signal-deck.rougue1.workers.dev/ack/' || ack_token;
      message_body := target_incident.display_id || ' unacknowledged for ' || policy.minutes_before_escalation
        || ' min: ' || target_incident.title || E'\nAcknowledge: ' || ack_link;

      if policy.notify_channel = 'whatsapp' then
        target_whatsapp := policy.escalate_to_whatsapp_number;
        if target_whatsapp is null and policy.escalate_to_resolver_group_id is not null then
          select m.whatsapp_number into target_whatsapp
          from on_call_rotations r
          join org_members m on m.user_id = r.user_id
          where r.resolver_group_id = policy.escalate_to_resolver_group_id
            and now() between r.starts_at and r.ends_at
          order by r.starts_at desc limit 1;
        end if;
        if target_whatsapp is not null then
          perform net.http_post(
            url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-whatsapp',
            headers := jsonb_build_object('Content-Type', 'application/json'),
            body := jsonb_build_object('to', target_whatsapp, 'incident_id', target_incident.display_id,
                                         'minutes', policy.minutes_before_escalation, 'ack_link', ack_link)
          );
        end if;
      else
        target_email := policy.escalate_to_email;
        if target_email is null and policy.escalate_to_resolver_group_id is not null then
          select u.email into target_email from on_call_rotations r
          join auth.users u on u.id = r.user_id
          where r.resolver_group_id = policy.escalate_to_resolver_group_id
            and now() between r.starts_at and r.ends_at
          order by r.starts_at desc limit 1;
        end if;
        if target_email is not null then
          perform net.http_post(
            url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
            headers := jsonb_build_object('Content-Type', 'application/json'),
            body := jsonb_build_object('to', target_email, 'subject', target_incident.display_id || ' — unacknowledged, escalating to you', 'body', message_body, 'from_name', sender_name)
          );
        end if;
      end if;

      update incidents set escalated_at = now() where id = target_incident.id;
    end loop;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.or_tsquery(search_query text)
 RETURNS tsquery
 LANGUAGE sql
 IMMUTABLE
 SET search_path = public
AS $function$
  select coalesce(
    string_agg(nullif(plainto_tsquery('english', word)::text, ''), ' | ')::tsquery,
    ''::tsquery
  )
  from unnest(regexp_split_to_array(trim(both from search_query), '\s+')) as word
  where length(word) > 0;
$function$;

CREATE OR REPLACE FUNCTION public.search_kb_articles(slug text, search_query text)
 RETURNS TABLE(id uuid, title text, body text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path = public
AS $function$
  select a.id, a.title, a.body
  from kb_articles a
  join organisations o on o.id = a.org_id
  where o.portal_slug = slug
    and length(trim(search_query)) > 0
    and a.search_vector @@ or_tsquery(search_query)
  order by ts_rank(a.search_vector, or_tsquery(search_query)) desc
  limit 3;
$function$;
