-- ============================================================================
-- SIGNAL DECK — Preventative action tracking (run after 1, 2, and 3)
-- ----------------------------------------------------------------------------
-- An RCA category alone tells you WHY something broke. It doesn't tell you
-- whether anyone actually did anything to stop it happening again. This adds
-- a real, trackable, closeable action item — the thing that turns "root
-- cause: capacity/load" into an accountable follow-up with an owner, a due
-- date, and a status, instead of a label that gets read once and forgotten.
-- ============================================================================

create table preventative_actions (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organisations(id) on delete cascade,
  incident_id uuid references incidents(id) on delete set null,
  rca_category_id uuid references rca_categories(id),
  description text not null,
  resolver_group_id uuid references resolver_groups(id),
  due_date date,
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'wont_fix')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_note text
);
create index on preventative_actions (org_id);
create index on preventative_actions (org_id, status);
create index on preventative_actions (incident_id);

alter table preventative_actions enable row level security;
create policy preventative_actions_org on preventative_actions for all using (org_id = current_org_id());
