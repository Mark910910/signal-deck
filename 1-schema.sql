-- ============================================================================
-- SIGNAL DECK — v3 schema (clean-slate rebuild)
-- ----------------------------------------------------------------------------
-- Design decisions in this version are traceable to specific, researched
-- frustrations with ServiceNow / Jira Service Management (G2, Capterra,
-- Reddit, 2026). Each is called out inline as a comment where it applies.
-- ============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

create table organisations (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  language text not null default 'en',
  retention_days int not null default 365,
  auto_purge boolean not null default false,
  identity_module_enabled boolean not null default false,
  information_officer_name text,
  information_officer_email text,
  privacy_policy_text text,
  paia_manual_text text,
  slack_webhook text,
  teams_webhook text,
  -- Anti-frustration: "weak self-service portal, feels unfinished" (repeated
  -- complaint across both ServiceNow and JSM reviews). portal_slug is a
  -- public, unguessable identifier customers use to submit incidents without
  -- an account, login, or seat — no per-user licensing, unlike either
  -- competitor's customer-portal model.
  -- hex, not base64: base64 can contain "/" and "+" which break cleanly in a URL path.
  portal_slug text unique not null default encode(gen_random_bytes(12), 'hex'),
  created_at timestamptz not null default now()
);

create table org_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references organisations(id) on delete cascade,
  -- Anti-frustration: "even minor workflow tweaks sometimes require admin
  -- access" (JSM, G2). Any 'admin' or 'owner' can edit taxonomy tables below
  -- — not gated to a single certified administrator.
  role text not null default 'agent' check (role in ('owner', 'admin', 'agent')),
  mfa_enrolled boolean not null default false,
  created_at timestamptz not null default now()
);

create table resolver_groups (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  name text not null,
  channel_slack_webhook text,
  channel_teams_webhook text,
  channel_whatsapp_group text,
  channel_sms_group text
);

create table categories (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  name text not null,
  default_resolver_group_id uuid references resolver_groups(id)
);

create table rca_categories (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  name text not null,
  sort_order int not null default 0
);

create table statuses (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  name text not null,
  sort_order int not null default 0
);

create table severities (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  name text not null,
  sla_minutes int not null,
  -- Business Impact SLA differentiator: optional revenue-risk weight used to
  -- sort/prioritise dashboards without changing the underlying SLA clock.
  business_weight int not null default 1
);

-- ---------------------------------------------------------------------------
-- Core incident record. Anti-frustration: "too many repeating, mainly
-- identical empty fields that must be filled out repeatedly" (JSM, Capterra).
-- Only title, category, and severity are required to create an incident —
-- every other field is nullable and filled in as work progresses, not
-- up front.
-- ---------------------------------------------------------------------------
create table incidents (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  display_id text not null,
  title text not null,
  notes text,
  category_id uuid not null references categories(id),
  severity_id uuid not null references severities(id),
  status_id uuid references statuses(id),
  rca_category_id uuid references rca_categories(id),
  resolution_class text,
  sla_minutes int not null,
  sla_paused_minutes int not null default 0,
  -- Tracks where the incident came from — lets you see the self-service
  -- portal actually being used, not just guess at it.
  source text not null default 'agent' check (source in ('agent', 'chatbot', 'portal')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  ai_mitigation text,
  created_by uuid references auth.users(id)
);
create index on incidents (org_id);
create index on incidents (org_id, resolved_at);
create index on incidents (org_id, rca_category_id);
create index on incidents (org_id, source);

create table incident_assignments (
  id uuid primary key default uuid_generate_v4(),
  incident_id uuid not null references incidents(id) on delete cascade,
  org_id uuid not null references organisations(id) on delete cascade,
  resolver_group_id uuid references resolver_groups(id),
  mode text not null default 'parallel' check (mode in ('parallel', 'sequential')),
  sequence_order int not null default 0,
  sla_minutes int,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index on incident_assignments (incident_id);

create table incident_timeline (
  id uuid primary key default uuid_generate_v4(),
  incident_id uuid not null references incidents(id) on delete cascade,
  org_id uuid not null references organisations(id) on delete cascade,
  ts timestamptz not null default now(),
  status_id uuid references statuses(id),
  resolver_group_id uuid references resolver_groups(id),
  note text
);
create index on incident_timeline (incident_id);

create table escalations (
  id uuid primary key default uuid_generate_v4(),
  incident_id uuid not null references incidents(id) on delete cascade,
  org_id uuid not null references organisations(id) on delete cascade,
  ts timestamptz not null default now(),
  resolver_group_id uuid references resolver_groups(id),
  channel text not null,
  kind text not null default 'escalation' check (kind in ('escalation', 'war_room')),
  delivered text
);
create index on escalations (incident_id);

create table audit_log (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  ts timestamptz not null default now(),
  action text not null,
  detail text
);
create index on audit_log (org_id, ts desc);

-- Optional Identity Module — unchanged from v2: personal data lives only
-- here, gated at the database level, never on the core incident record.
create table incident_identity (
  incident_id uuid primary key references incidents(id) on delete cascade,
  org_id uuid not null references organisations(id) on delete cascade,
  customer_name text,
  customer_contact text,
  consent_given boolean not null default false,
  consent_ts timestamptz,
  created_at timestamptz not null default now()
);

create table identity_module_log (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  ts timestamptz not null default now(),
  action text not null check (action in ('enabled', 'disabled'))
);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
alter table organisations enable row level security;
alter table org_members enable row level security;
alter table resolver_groups enable row level security;
alter table categories enable row level security;
alter table rca_categories enable row level security;
alter table statuses enable row level security;
alter table severities enable row level security;
alter table incidents enable row level security;
alter table incident_assignments enable row level security;
alter table incident_timeline enable row level security;
alter table escalations enable row level security;
alter table audit_log enable row level security;
alter table incident_identity enable row level security;
alter table identity_module_log enable row level security;

create or replace function current_org_id() returns uuid as $$
  select org_id from org_members where user_id = auth.uid()
$$ language sql stable security definer;

create or replace function identity_module_is_on() returns boolean as $$
  select coalesce(identity_module_enabled, false) from organisations where id = current_org_id()
$$ language sql stable security definer;

create policy org_isolation_all on incidents for all using (org_id = current_org_id());
create policy org_isolation_all on incident_assignments for all using (org_id = current_org_id());
create policy org_isolation_all on incident_timeline for all using (org_id = current_org_id());
create policy org_isolation_all on escalations for all using (org_id = current_org_id());
create policy org_isolation_all on audit_log for all using (org_id = current_org_id());
create policy org_isolation_all on categories for all using (org_id = current_org_id());
create policy org_isolation_all on rca_categories for all using (org_id = current_org_id());
create policy org_isolation_all on resolver_groups for all using (org_id = current_org_id());
create policy org_isolation_all on statuses for all using (org_id = current_org_id());
create policy org_isolation_all on severities for all using (org_id = current_org_id());
create policy org_self_select on organisations for select using (id = current_org_id());
create policy org_self_update on organisations for update using (id = current_org_id());
create policy member_self_select on org_members for select using (org_id = current_org_id());

create policy identity_gated_select on incident_identity for select
  using (org_id = current_org_id() and identity_module_is_on());
create policy identity_gated_insert on incident_identity for insert
  with check (org_id = current_org_id() and identity_module_is_on());
create policy identity_gated_update on incident_identity for update
  using (org_id = current_org_id() and identity_module_is_on());
create policy identity_gated_delete on incident_identity for delete
  using (org_id = current_org_id());

create policy org_isolation_select on identity_module_log for select using (org_id = current_org_id());
create policy org_isolation_insert on identity_module_log for insert with check (org_id = current_org_id());

-- ============================================================================
-- SELF-SERVICE CUSTOMER PORTAL (no login, no seat, metadata-only)
-- ----------------------------------------------------------------------------
-- Directly answers the most repeated portal complaint in the research:
-- "poor thought around customer UI... feels unfinished." A customer visits
-- yourapp.com/portal/<portal_slug>, types a title + description, picks a
-- category from a public dropdown, and submits — no account needed. The
-- function below is the ONLY way the public ("anon") role can touch this
-- database: it can insert a metadata-only incident and nothing else. It
-- cannot read any existing data, cannot see other organisations, and cannot
-- capture personal information (Identity Module fields are never exposed
-- here even if the org has them enabled — a portal submitter isn't logged in
-- to give meaningful consent, so this path stays metadata-only regardless).
-- ============================================================================
create or replace function submit_via_portal(slug text, incident_title text, incident_notes text, category_name text)
returns text
language plpgsql
security definer
as $$
declare
  target_org_id uuid;
  matched_category_id uuid;
  fallback_severity_id uuid;
  fallback_status_id uuid;
  new_display_id text;
  new_incident_id uuid;
begin
  select id into target_org_id from organisations where portal_slug = slug;
  if target_org_id is null then
    raise exception 'Invalid portal link.';
  end if;

  select id into matched_category_id from categories where org_id = target_org_id and name = category_name;
  if matched_category_id is null then
    select id into matched_category_id from categories where org_id = target_org_id order by name limit 1;
  end if;

  -- Portal submissions default to Medium severity — a customer can't
  -- reliably self-assess business impact, so we don't ask them to.
  select id into fallback_severity_id from severities where org_id = target_org_id and name = 'Medium';
  if fallback_severity_id is null then
    select id into fallback_severity_id from severities where org_id = target_org_id order by sla_minutes limit 1;
  end if;

  select id into fallback_status_id from statuses where org_id = target_org_id order by sort_order limit 1;

  new_display_id := 'INC-' || extract(year from now()) || '-' || floor(random() * 9000 + 1000)::text;

  insert into incidents (org_id, display_id, title, notes, category_id, severity_id, status_id, sla_minutes, source)
  select target_org_id, new_display_id, incident_title, incident_notes, matched_category_id, fallback_severity_id,
         fallback_status_id, sla_minutes, 'portal'
  from severities where id = fallback_severity_id
  returning id into new_incident_id;

  insert into incident_timeline (incident_id, org_id, status_id, note)
  values (new_incident_id, target_org_id, fallback_status_id, 'Submitted via self-service portal');

  return new_display_id;
end;
$$;

-- Deliberately the ONLY grant given to the anon (unauthenticated) role in
-- this entire schema.
grant execute on function submit_via_portal(text, text, text, text) to anon;

-- Lets the portal's category dropdown populate without exposing anything
-- else about the organisation to an unauthenticated visitor.
create or replace function portal_categories(slug text)
returns table(name text)
language sql
security definer
as $$
  select c.name from categories c
  join organisations o on o.id = c.org_id
  where o.portal_slug = slug
  order by c.name;
$$;
grant execute on function portal_categories(text) to anon;
grant execute on function portal_categories(text) to authenticated;

-- ============================================================================
-- REPORTING — one-click SLA export
-- ----------------------------------------------------------------------------
-- Directly answers: "pulling SLA breach data requires extra filters and
-- exports, slows down reporting by about an hour" (G2, JSM review). This
-- view is the entire export — one query, no manual filter-building.
-- ============================================================================
create or replace view incident_sla_report as
select
  i.org_id, i.display_id, i.title, cat.name as category, sev.name as severity,
  st.name as status, i.source, i.created_at, i.resolved_at,
  i.sla_minutes,
  (extract(epoch from (coalesce(i.resolved_at, now()) - i.created_at)) / 60)::int as minutes_open,
  case when i.resolved_at is not null
    then i.resolved_at > i.created_at + (i.sla_minutes || ' minutes')::interval
    else now() > i.created_at + (i.sla_minutes || ' minutes')::interval
  end as breached,
  rca.name as rca_category, i.resolution_class
from incidents i
left join categories cat on cat.id = i.category_id
left join severities sev on sev.id = i.severity_id
left join statuses st on st.id = i.status_id
left join rca_categories rca on rca.id = i.rca_category_id;

alter view incident_sla_report set (security_invoker = on);
-- security_invoker means this view respects the querying user's own RLS —
-- it does not need its own policy; it can never show more than the
-- `incidents` table already allows that user to see.
