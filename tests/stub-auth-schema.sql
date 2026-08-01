-- Supabase provides a real "auth" schema (users, sessions, auth.uid(), etc.)
-- via its own auth service. A plain Postgres container in CI doesn't have
-- that service, so this stub recreates just enough of it — a users table
-- and an auth.uid() function reading from a Postgres session setting — for
-- the schema and its functions to be tested honestly. This file is CI-only
-- and is never run against the real Supabase project (Supabase already
-- provides the real thing there).

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

create schema if not exists auth;

create table auth.users (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Supabase's two standard API roles — the schema's GRANT statements target
-- these, so they need to exist for the schema to apply cleanly in CI.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end $$;

