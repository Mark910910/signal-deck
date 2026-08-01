-- ============================================================================
-- SIGNAL DECK — Integrations layer (run after 1-schema.sql and 2-bootstrap.sql)
-- ----------------------------------------------------------------------------
-- Lets a customer's own bespoke systems talk to Signal Deck without a human
-- login: an API key for their system to call in, and webhooks for Signal
-- Deck to call out to their system. Same design principle as the public
-- portal — a handful of narrow, specific functions an external caller can
-- use, never a generic database connection.
-- ============================================================================

create or replace function current_org_role() returns text as $$
  select role from org_members where user_id = auth.uid()
$$ language sql stable security definer;

-- ---------------------------------------------------------------------------
-- API keys — for a customer's bespoke system to call IN to Signal Deck.
-- Only the raw key's hash is ever stored; the real key is shown exactly once,
-- at creation, the same way a bank shows you a card PIN once and never again.
-- ---------------------------------------------------------------------------
create table api_keys (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  label text not null,
  key_hash text not null unique,
  key_prefix text not null,
  scopes text[] not null default array['create_incidents'],
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index on api_keys (org_id);

alter table api_keys enable row level security;
-- Only an owner or admin can see or manage keys — these are credentials,
-- not everyday configuration, so a regular agent shouldn't touch them.
create policy api_keys_owner_admin on api_keys for all
  using (org_id = current_org_id() and current_org_role() in ('owner', 'admin'));

create or replace function create_api_key(label text, scopes text[] default array['create_incidents'])
returns table(raw_key text, key_id uuid)
language plpgsql
security definer
as $$
declare
  my_org uuid;
  my_role text;
  generated_key text;
  generated_prefix text;
  new_id uuid;
begin
  select org_id, role into my_org, my_role from org_members where user_id = auth.uid();
  if my_role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can create API keys.';
  end if;

  generated_key := 'sk_live_' || encode(gen_random_bytes(24), 'hex');
  generated_prefix := left(generated_key, 14) || '…';

  insert into api_keys (org_id, label, key_hash, key_prefix, scopes)
  values (my_org, label, encode(digest(generated_key, 'sha256'), 'hex'), generated_prefix, scopes)
  returning id into new_id;

  insert into audit_log (org_id, actor_user_id, action, detail)
  values (my_org, auth.uid(), 'api_key_created', 'Key "' || label || '" created with scopes: ' || array_to_string(scopes, ', '));

  return query select generated_key, new_id;
end;
$$;
grant execute on function create_api_key(text, text[]) to authenticated;

create or replace function revoke_api_key(target_key_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  my_org uuid;
  my_role text;
begin
  select org_id, role into my_org, my_role from org_members where user_id = auth.uid();
  if my_role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can revoke API keys.';
  end if;
  update api_keys set revoked_at = now() where id = target_key_id and org_id = my_org;
  insert into audit_log (org_id, actor_user_id, action, detail) values (my_org, auth.uid(), 'api_key_revoked', target_key_id::text);
end;
$$;
grant execute on function revoke_api_key(uuid) to authenticated;

-- Shared helper: validate a raw API key, confirm it holds the required
-- scope, and return its organisation. Every inbound integration function
-- below calls this first and refuses to proceed if it fails.
create or replace function validate_api_key(raw_key text, required_scope text)
returns uuid
language plpgsql
security definer
as $$
declare
  matched_org uuid;
  matched_id uuid;
  matched_scopes text[];
  matched_revoked timestamptz;
begin
  select org_id, id, scopes, revoked_at into matched_org, matched_id, matched_scopes, matched_revoked
  from api_keys where key_hash = encode(digest(raw_key, 'sha256'), 'hex');

  if matched_org is null then
    raise exception 'Invalid API key.';
  end if;
  if matched_revoked is not null then
    raise exception 'This API key has been revoked.';
  end if;
  if not (required_scope = any(matched_scopes)) then
    raise exception 'This API key does not have the % scope.', required_scope;
  end if;

  update api_keys set last_used_at = now() where id = matched_id;
  return matched_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Inbound integration actions — narrow, specific, metadata-only. A bespoke
-- customer system authenticates by passing its API key as a plain argument
-- (called over HTTPS, so this is as safe as any bearer-token API); there is
-- no generic query capability, and incident_identity is never reachable
-- through any of these, regardless of scope.
-- ---------------------------------------------------------------------------
create or replace function api_create_incident(api_key text, incident_title text, incident_notes text, category_name text, severity_name text default 'Medium')
returns text
language plpgsql
security definer
as $$
declare
  target_org uuid;
  matched_category_id uuid;
  matched_severity_id uuid;
  matched_status_id uuid;
  new_display_id text;
  new_incident_id uuid;
begin
  target_org := validate_api_key(api_key, 'create_incidents');

  select id into matched_category_id from categories where org_id = target_org and name = category_name;
  if matched_category_id is null then
    select id into matched_category_id from categories where org_id = target_org order by name limit 1;
  end if;

  select id into matched_severity_id from severities where org_id = target_org and name = severity_name;
  if matched_severity_id is null then
    select id into matched_severity_id from severities where org_id = target_org and name = 'Medium';
  end if;

  select id into matched_status_id from statuses where org_id = target_org order by sort_order limit 1;
  new_display_id := 'INC-' || extract(year from now()) || '-' || floor(random() * 9000 + 1000)::text;

  insert into incidents (org_id, display_id, title, notes, category_id, severity_id, status_id, sla_minutes, source)
  select target_org, new_display_id, incident_title, incident_notes, matched_category_id, matched_severity_id, matched_status_id, sla_minutes, 'api'
  from severities where id = matched_severity_id
  returning id into new_incident_id;

  insert into incident_timeline (incident_id, org_id, status_id, note)
  values (new_incident_id, target_org, matched_status_id, 'Created via API integration');

  return new_display_id;
end;
$$;
grant execute on function api_create_incident(text, text, text, text, text) to anon;

create or replace function api_update_status(api_key text, incident_display_id text, new_status_name text)
returns void
language plpgsql
security definer
as $$
declare
  target_org uuid;
  matched_incident_id uuid;
  matched_status_id uuid;
begin
  target_org := validate_api_key(api_key, 'update_incidents');

  select id into matched_incident_id from incidents where org_id = target_org and display_id = incident_display_id;
  if matched_incident_id is null then
    raise exception 'No incident with that reference number for this organisation.';
  end if;

  select id into matched_status_id from statuses where org_id = target_org and name = new_status_name;
  if matched_status_id is null then
    raise exception 'Unknown status name.';
  end if;

  update incidents set status_id = matched_status_id where id = matched_incident_id;
  insert into incident_timeline (incident_id, org_id, status_id, note)
  values (matched_incident_id, target_org, matched_status_id, 'Status updated via API integration');
end;
$$;
grant execute on function api_update_status(text, text, text) to anon;

create or replace function api_list_incidents(api_key text, since timestamptz default null)
returns table(
  display_id text, title text, category text, severity text, status text,
  source text, created_at timestamptz, resolved_at timestamptz
)
language plpgsql
security definer
as $$
declare
  target_org uuid;
begin
  target_org := validate_api_key(api_key, 'read_incidents');

  return query
    select i.display_id, i.title, cat.name, sev.name, st.name, i.source, i.created_at, i.resolved_at
    from incidents i
    left join categories cat on cat.id = i.category_id
    left join severities sev on sev.id = i.severity_id
    left join statuses st on st.id = i.status_id
    where i.org_id = target_org and (since is null or i.created_at >= since)
    order by i.created_at desc
    limit 200;
end;
$$;
grant execute on function api_list_incidents(text, timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- Outbound webhooks — Signal Deck calling OUT to a customer's own system the
-- moment something changes, so their bespoke tool never has to poll.
-- ---------------------------------------------------------------------------
create table integration_webhooks (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  label text not null,
  url text not null,
  secret text not null,
  event_types text[] not null default array['incident.created', 'incident.resolved'],
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_triggered_at timestamptz,
  last_status int
);
create index on integration_webhooks (org_id);

alter table integration_webhooks enable row level security;
create policy webhooks_owner_admin on integration_webhooks for all
  using (org_id = current_org_id() and current_org_role() in ('owner', 'admin'));

-- pg_net lets Postgres itself make outbound HTTP calls. It's a real Supabase
-- extension available on every project, including free tier — but it isn't
-- present in the generic Postgres container this schema is tested against in
-- CI, so this block installs it if available and simply skips webhook
-- delivery (without failing the whole migration) if it isn't. Everything
-- else in this file is still fully tested either way.
do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net not available in this environment — outbound webhook delivery will be inactive here (this is expected in CI; Supabase provides it in production).';
end $$;

create or replace function notify_webhooks() returns trigger as $$
declare
  hook record;
  payload jsonb;
  event_name text;
  signature text;
  pg_net_present boolean;
begin
  select exists(select 1 from pg_extension where extname = 'pg_net') into pg_net_present;
  if not pg_net_present then
    return coalesce(NEW, OLD);
  end if;

  if TG_OP = 'INSERT' then
    event_name := 'incident.created';
  elsif TG_OP = 'UPDATE' and NEW.resolved_at is not null and OLD.resolved_at is null then
    event_name := 'incident.resolved';
  elsif TG_OP = 'UPDATE' and NEW.status_id is distinct from OLD.status_id then
    event_name := 'incident.status_changed';
  else
    return NEW;
  end if;

  payload := jsonb_build_object(
    'event', event_name,
    'incident', jsonb_build_object(
      'display_id', NEW.display_id, 'title', NEW.title, 'source', NEW.source,
      'created_at', NEW.created_at, 'resolved_at', NEW.resolved_at
    )
  );

  for hook in select * from integration_webhooks where org_id = NEW.org_id and active = true and event_name = any(event_types)
  loop
    signature := encode(hmac(payload::text, hook.secret, 'sha256'), 'hex');
    perform net.http_post(
      url := hook.url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Signal-Deck-Signature', signature),
      body := payload
    );
    update integration_webhooks set last_triggered_at = now() where id = hook.id;
  end loop;

  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists incidents_webhook_trigger on incidents;
create trigger incidents_webhook_trigger
after insert or update on incidents
for each row execute function notify_webhooks();

-- ---------------------------------------------------------------------------
-- Automation Rules — fully native. No external account, no third-party
-- sign-up, ever, for the customer. "When X happens, email Y" configured
-- entirely inside Signal Deck's own Settings screen.
-- ---------------------------------------------------------------------------
create table automation_rules (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  label text not null,
  event_type text not null check (event_type in ('incident.created', 'incident.resolved', 'incident.status_changed')),
  filter_category_id uuid references categories(id),
  filter_severity_id uuid references severities(id),
  action_email_to text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_triggered_at timestamptz
);
create index on automation_rules (org_id);

alter table automation_rules enable row level security;
create policy automation_rules_org on automation_rules for all using (org_id = current_org_id());

create or replace function notify_automation_rules() returns trigger as $$
declare
  rule record;
  event_name text;
  pg_net_present boolean;
  email_subject text;
  email_body text;
begin
  select exists(select 1 from pg_extension where extname = 'pg_net') into pg_net_present;
  if not pg_net_present then
    return coalesce(NEW, OLD);
  end if;

  if TG_OP = 'INSERT' then
    event_name := 'incident.created';
  elsif TG_OP = 'UPDATE' and NEW.resolved_at is not null and OLD.resolved_at is null then
    event_name := 'incident.resolved';
  elsif TG_OP = 'UPDATE' and NEW.status_id is distinct from OLD.status_id then
    event_name := 'incident.status_changed';
  else
    return NEW;
  end if;

  for rule in
    select * from automation_rules
    where org_id = NEW.org_id and active = true and event_type = event_name
      and (filter_category_id is null or filter_category_id = NEW.category_id)
      and (filter_severity_id is null or filter_severity_id = NEW.severity_id)
  loop
    email_subject := NEW.display_id || ' — ' || event_name;
    email_body := 'Incident: ' || NEW.title || E'\nReference: ' || NEW.display_id || E'\nEvent: ' || event_name;

    -- Replace YOUR-PROJECT-REF below with your actual Supabase project
    -- reference (found in Project Settings -> General) before running this
    -- file — this is the one placeholder in this whole schema that needs a
    -- manual edit, since a database trigger can't discover its own
    -- project's public URL automatically.
    perform net.http_post(
      url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-email',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('to', rule.action_email_to, 'subject', email_subject, 'body', email_body)
    );
    update automation_rules set last_triggered_at = now() where id = rule.id;
  end loop;

  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists incidents_automation_trigger on incidents;
create trigger incidents_automation_trigger
after insert or update on incidents
for each row execute function notify_automation_rules();
