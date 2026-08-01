-- Run this AFTER schema-v3.sql. Creates the one-time function a new
-- sign-up calls to create their organisation, become its owner, and seed
-- working defaults — including business-impact weights per severity, so
-- the Business Impact SLA differentiator has real data from day one
-- instead of showing an empty, confusing dashboard.

create or replace function create_organisation_and_owner(org_name text, org_language text default 'en')
returns uuid
language plpgsql
security definer
as $$
declare
  new_org_id uuid;
begin
  if exists (select 1 from org_members where user_id = auth.uid()) then
    raise exception 'This account is already linked to an organisation.';
  end if;

  insert into organisations (name, language) values (org_name, org_language) returning id into new_org_id;
  insert into org_members (user_id, org_id, role) values (auth.uid(), new_org_id, 'owner');

  insert into resolver_groups (org_id, name) values
    (new_org_id, 'IT'), (new_org_id, 'Network'), (new_org_id, 'Facilities'),
    (new_org_id, 'HR'), (new_org_id, 'Vendor Management');

  insert into categories (org_id, name) values
    (new_org_id, 'Hardware'), (new_org_id, 'Software'), (new_org_id, 'Network'),
    (new_org_id, 'Access & Security'), (new_org_id, 'Facilities'), (new_org_id, 'Other');

  insert into statuses (org_id, name, sort_order) values
    (new_org_id, 'New', 1), (new_org_id, 'Acknowledged', 2), (new_org_id, 'In Progress', 3),
    (new_org_id, 'Pending Vendor', 4), (new_org_id, 'Escalated', 5),
    (new_org_id, 'Resolved', 6), (new_org_id, 'Closed', 7);

  insert into severities (org_id, name, sla_minutes, business_weight) values
    (new_org_id, 'Critical', 60, 4), (new_org_id, 'High', 240, 3),
    (new_org_id, 'Medium', 1440, 2), (new_org_id, 'Low', 4320, 1);

  insert into rca_categories (org_id, name, sort_order) values
    (new_org_id, 'Hardware failure', 1), (new_org_id, 'Software bug', 2),
    (new_org_id, 'Configuration error', 3), (new_org_id, 'Third-party/vendor outage', 4),
    (new_org_id, 'Human error — process', 5), (new_org_id, 'Capacity/load', 6),
    (new_org_id, 'Unknown', 7);

  insert into audit_log (org_id, actor_user_id, action, detail)
  values (new_org_id, auth.uid(), 'org_created', 'Organisation created and seeded with defaults');

  return new_org_id;
end;
$$;

grant execute on function create_organisation_and_owner(text, text) to authenticated;

create or replace function set_identity_module(enabled boolean)
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
    raise exception 'Only an owner or admin can change the Identity Module setting.';
  end if;
  update organisations set identity_module_enabled = enabled where id = my_org;
  insert into identity_module_log (org_id, actor_user_id, action)
  values (my_org, auth.uid(), case when enabled then 'enabled' else 'disabled' end);
end;
$$;

grant execute on function set_identity_module(boolean) to authenticated;

-- Lets an owner/admin regenerate the public portal link if it's ever leaked
-- or needs rotating — without needing to touch SQL themselves.
create or replace function rotate_portal_slug()
returns text
language plpgsql
security definer
as $$
declare
  my_org uuid;
  my_role text;
  new_slug text;
begin
  select org_id, role into my_org, my_role from org_members where user_id = auth.uid();
  if my_role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can rotate the portal link.';
  end if;
  new_slug := encode(gen_random_bytes(12), 'hex');
  update organisations set portal_slug = new_slug where id = my_org;
  insert into audit_log (org_id, actor_user_id, action, detail) values (my_org, auth.uid(), 'portal_link_rotated', 'Public portal link regenerated');
  return new_slug;
end;
$$;

grant execute on function rotate_portal_slug() to authenticated;
