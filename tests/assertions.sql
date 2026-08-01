-- Automated schema assertions. This file is never run by hand — GitHub
-- Actions runs it automatically against a disposable test database on every
-- push, so a mistake in the SQL is caught before it ever reaches the real
-- Supabase project. Each check RAISE EXCEPTIONs on failure, which makes the
-- whole CI run fail loudly (a red X on the repo) rather than silently.

do $$
declare
  missing text;
begin
  select string_agg(t, ', ') into missing from unnest(array[
    'organisations','org_members','resolver_groups','categories','rca_categories',
    'statuses','severities','incidents','incident_assignments','incident_timeline',
    'escalations','audit_log','incident_identity','identity_module_log'
  ]) as t
  where not exists (select 1 from information_schema.tables where table_name = t);
  if missing is not null then
    raise exception 'Missing expected table(s): %', missing;
  end if;
  raise notice 'PASS: all expected tables exist';
end $$;

do $$
declare
  unprotected text;
begin
  select string_agg(t, ', ') into unprotected from unnest(array[
    'organisations','org_members','resolver_groups','categories','rca_categories',
    'statuses','severities','incidents','incident_assignments','incident_timeline',
    'escalations','audit_log','incident_identity','identity_module_log'
  ]) as t
  where not exists (
    select 1 from pg_tables where tablename = t and rowsecurity = true
  );
  if unprotected is not null then
    raise exception 'Row Level Security is NOT enabled on: % — this would mean no real tenant isolation', unprotected;
  end if;
  raise notice 'PASS: Row Level Security is enabled on every tenant-scoped table';
end $$;

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'submit_via_portal') then
    raise exception 'submit_via_portal function is missing';
  end if;
  if not exists (select 1 from pg_proc where proname = 'portal_categories') then
    raise exception 'portal_categories function is missing';
  end if;
  if not exists (select 1 from pg_proc where proname = 'create_organisation_and_owner') then
    raise exception 'create_organisation_and_owner function is missing — sign-up would be broken';
  end if;
  if not exists (select 1 from pg_proc where proname = 'set_identity_module') then
    raise exception 'set_identity_module function is missing';
  end if;
  if not exists (select 1 from pg_proc where proname = 'rotate_portal_slug') then
    raise exception 'rotate_portal_slug function is missing';
  end if;
  raise notice 'PASS: all required functions exist';
end $$;

do $$
declare
  grantee_count int;
begin
  select count(*) into grantee_count
  from information_schema.role_routine_grants
  where routine_name = 'submit_via_portal' and grantee = 'anon';
  if grantee_count = 0 then
    raise exception 'submit_via_portal is not granted to anon — the public portal would be unreachable';
  end if;
  raise notice 'PASS: public portal function is reachable by unauthenticated visitors';
end $$;

-- End-to-end functional test: actually create a fake organisation the way
-- sign-up does, and confirm it comes out seeded and usable — not just that
-- the function exists, but that running it produces a working workspace.
do $$
declare
  test_user_id uuid := uuid_generate_v4();
  test_org_id uuid;
  cat_count int;
  sev_count int;
begin
  insert into auth.users (id) values (test_user_id);
  perform set_config('request.jwt.claim.sub', test_user_id::text, true);

  -- create_organisation_and_owner reads auth.uid(); the stub function in
  -- this test environment returns the id we just configured above.
  select create_organisation_and_owner('CI Test Org', 'en') into test_org_id;

  select count(*) into cat_count from categories where org_id = test_org_id;
  select count(*) into sev_count from severities where org_id = test_org_id;

  if cat_count = 0 then raise exception 'New organisation was not seeded with categories'; end if;
  if sev_count = 0 then raise exception 'New organisation was not seeded with severities'; end if;

  raise notice 'PASS: a brand-new sign-up produces a fully seeded, working organisation';
end $$;

-- Integrations layer: tables, functions, and grants.
do $$
declare
  missing text;
begin
  select string_agg(t, ', ') into missing from unnest(array['api_keys','integration_webhooks']) as t
  where not exists (select 1 from information_schema.tables where table_name = t);
  if missing is not null then raise exception 'Missing integrations table(s): %', missing; end if;

  if not exists (select 1 from pg_proc where proname = 'create_api_key') then raise exception 'create_api_key missing'; end if;
  if not exists (select 1 from pg_proc where proname = 'api_create_incident') then raise exception 'api_create_incident missing'; end if;
  if not exists (select 1 from pg_proc where proname = 'api_update_status') then raise exception 'api_update_status missing'; end if;
  if not exists (select 1 from pg_proc where proname = 'api_list_incidents') then raise exception 'api_list_incidents missing'; end if;

  raise notice 'PASS: integrations layer tables and functions exist';
end $$;

-- End-to-end: a real API key, created the way an owner would, actually
-- creates and reads back an incident — not just that the functions exist.
do $$
declare
  test_user_id uuid := uuid_generate_v4();
  test_org_id uuid;
  generated_key text;
  created_display_id text;
  found_count int;
begin
  insert into auth.users (id) values (test_user_id);
  perform set_config('request.jwt.claim.sub', test_user_id::text, true);
  select create_organisation_and_owner('CI Integrations Test Org', 'en') into test_org_id;

  select raw_key into generated_key from create_api_key('CI test key', array['create_incidents','read_incidents']);
  if generated_key is null then raise exception 'create_api_key did not return a usable key'; end if;

  select api_create_incident(generated_key, 'CI test incident', 'created by automated test', 'Software', 'Medium') into created_display_id;
  if created_display_id is null then raise exception 'api_create_incident did not return a reference number'; end if;

  select count(*) into found_count from api_list_incidents(generated_key, null) where display_id = created_display_id;
  if found_count = 0 then raise exception 'Incident created via API key was not returned by api_list_incidents'; end if;

  raise notice 'PASS: API key creation, incident creation, and incident listing all work end-to-end';
end $$;

-- A revoked key must stop working — this is the check that actually matters
-- for security, not just that revoke_api_key runs without error.
do $$
declare
  test_user_id uuid := uuid_generate_v4();
  test_org_id uuid;
  generated_key text;
  generated_key_id uuid;
  should_fail boolean := false;
begin
  insert into auth.users (id) values (test_user_id);
  perform set_config('request.jwt.claim.sub', test_user_id::text, true);
  select create_organisation_and_owner('CI Revocation Test Org', 'en') into test_org_id;

  select raw_key, key_id into generated_key, generated_key_id from create_api_key('CI revoke test key', array['create_incidents']);
  perform revoke_api_key(generated_key_id);

  begin
    perform api_create_incident(generated_key, 'should not be created', 'this key was revoked', 'Software', 'Medium');
    should_fail := true;
  exception when others then
    null; -- expected: the call must raise an exception
  end;

  if should_fail then
    raise exception 'A revoked API key was still able to create an incident — this is a real security bug';
  end if;

  raise notice 'PASS: a revoked API key is correctly refused';
end $$;

-- Automation Rules: fully native, no external account.
do $$
begin
  if not exists (select 1 from information_schema.tables where table_name = 'automation_rules') then
    raise exception 'automation_rules table is missing';
  end if;
  if not exists (select 1 from pg_tables where tablename = 'automation_rules' and rowsecurity = true) then
    raise exception 'automation_rules does not have Row Level Security enabled';
  end if;
  raise notice 'PASS: automation_rules table exists and is protected';
end $$;

-- Preventative action tracking.
do $$
begin
  if not exists (select 1 from information_schema.tables where table_name = 'preventative_actions') then
    raise exception 'preventative_actions table is missing';
  end if;
  if not exists (select 1 from pg_tables where tablename = 'preventative_actions' and rowsecurity = true) then
    raise exception 'preventative_actions does not have Row Level Security enabled';
  end if;
  raise notice 'PASS: preventative_actions table exists and is protected';
end $$;

-- Custom dashboards & charts.
do $$
declare
  missing text;
begin
  select string_agg(t, ', ') into missing from unnest(array['custom_charts','custom_dashboards','custom_dashboard_charts']) as t
  where not exists (select 1 from information_schema.tables where table_name = t);
  if missing is not null then raise exception 'Missing custom dashboard table(s): %', missing; end if;

  select string_agg(t, ', ') into missing from unnest(array['custom_charts','custom_dashboards','custom_dashboard_charts']) as t
  where not exists (select 1 from pg_tables where tablename = t and rowsecurity = true);
  if missing is not null then raise exception 'Missing Row Level Security on: %', missing; end if;

  raise notice 'PASS: custom dashboard tables exist and are protected';
end $$;

-- End-to-end: build a chart the way the UI does, put it on a dashboard,
-- and confirm the join actually returns it back out.
do $$
declare
  test_user_id uuid := uuid_generate_v4();
  test_org_id uuid;
  test_dashboard_id uuid;
  test_chart_id uuid;
  found_count int;
begin
  insert into auth.users (id) values (test_user_id);
  perform set_config('request.jwt.claim.sub', test_user_id::text, true);
  select create_organisation_and_owner('CI Dashboard Test Org', 'en') into test_org_id;

  insert into custom_dashboards (org_id, name) values (test_org_id, 'CI test dashboard') returning id into test_dashboard_id;
  insert into custom_charts (org_id, name, chart_type, group_by) values (test_org_id, 'CI test chart', 'bar', 'category') returning id into test_chart_id;
  insert into custom_dashboard_charts (org_id, dashboard_id, chart_id) values (test_org_id, test_dashboard_id, test_chart_id);

  select count(*) into found_count from custom_dashboard_charts where dashboard_id = test_dashboard_id;
  if found_count = 0 then raise exception 'A chart placed on a dashboard was not returned by the join'; end if;

  raise notice 'PASS: charts can be built, placed on a dashboard, and read back';
end $$;
