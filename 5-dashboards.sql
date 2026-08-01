-- ============================================================================
-- SIGNAL DECK — Custom charts & dashboards (run after 1, 2, 3, and 4)
-- ----------------------------------------------------------------------------
-- Deliberately stores only chart CONFIGURATION, not chart data. The actual
-- numbers are computed live in the app from incidents already being
-- fetched — so a chart is always current the moment it's viewed, and
-- nothing here needs its own query language; every option is a dropdown.
--
-- A chart is reusable across any number of dashboards (custom_dashboard_charts
-- is the join, carrying per-placement layout — width and order — so the same
-- "Incidents by category" chart can sit full-width on one dashboard and
-- half-width on another).
-- ============================================================================

create table custom_dashboards (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index on custom_dashboards (org_id);

create table custom_charts (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  name text not null,
  chart_type text not null check (chart_type in ('bar', 'line', 'pie')),
  metric text not null default 'count' check (metric in ('count', 'avg_resolution_hours', 'breach_rate')),
  group_by text not null check (group_by in ('category', 'severity', 'status', 'rca_category', 'resolver_group', 'source', 'month', 'week')),
  filter_status text,
  filter_range_days int,
  filter_category_id uuid references categories(id),
  filter_severity_id uuid references severities(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index on custom_charts (org_id);

create table custom_dashboard_charts (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  dashboard_id uuid not null references custom_dashboards(id) on delete cascade,
  chart_id uuid not null references custom_charts(id) on delete cascade,
  width text not null default 'half' check (width in ('half', 'full')),
  sort_order int not null default 0
);
create index on custom_dashboard_charts (dashboard_id);

alter table custom_dashboards enable row level security;
alter table custom_charts enable row level security;
alter table custom_dashboard_charts enable row level security;

create policy custom_dashboards_org on custom_dashboards for all using (org_id = current_org_id());
create policy custom_charts_org on custom_charts for all using (org_id = current_org_id());
create policy custom_dashboard_charts_org on custom_dashboard_charts for all using (org_id = current_org_id());
