-- ============================================================================
-- SIGNAL DECK — LIVE SCHEMA SNAPSHOT
-- ----------------------------------------------------------------------------
-- Pulled directly from the live Supabase project (ref: soybukxnvtghebeuhsbg,
-- "Signal Deck", region eu-west-1, Postgres 17.6) on 2026-08-22.
--
-- This is a read-only snapshot for reference/diffing purposes — it reflects
-- what is ACTUALLY deployed right now, which may have drifted from
-- 1-schema.sql / 2-bootstrap.sql / 3-integrations.sql / 4-preventatives.sql /
-- 5-dashboards.sql. It is not meant to be re-run to provision a fresh
-- database (order of CREATEs here is grouped by kind, not by dependency).
--
-- KNOWN LIVE BUG found while generating this snapshot: the trigger functions
-- notify_vendor_of_resolution() and notify_vendor_of_staff_reply() (below)
-- both `select * from incident_vendor_access ...`, but no such table, view,
-- or matview exists anywhere in this schema — the real table is
-- incident_vendors, which has no token/contact columns at all. Both
-- functions are wired to live AFTER triggers (notify_vendor_on_resolution on
-- incidents, notify_vendor_on_staff_reply on incident_comments) and pg_net
-- is installed, so the early-exit guard does not save them: resolving any
-- incident, or a staff reply with visibility='vendor', will hit
-- `relation "incident_vendor_access" does not exist` and the triggering
-- statement will abort. A third function, notify_vendor_on_link(), has the
-- same bug but is not attached to any trigger, so it is currently dead code.
-- ============================================================================


-- ============================================================================
-- EXTENSIONS
-- ============================================================================

create extension if not exists "pg_cron" with version '1.6.4';
create extension if not exists "pg_net" with version '0.20.4';
create extension if not exists "pg_stat_statements" with version '1.11';
create extension if not exists "pgcrypto" with version '1.3';
create extension if not exists "supabase_vault" with version '0.3.1';
create extension if not exists "uuid-ossp" with version '1.1';


-- ============================================================================
-- TABLES
-- ============================================================================

CREATE TABLE public.organisations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  language text NOT NULL DEFAULT 'en'::text,
  retention_days integer NOT NULL DEFAULT 365,
  auto_purge boolean NOT NULL DEFAULT false,
  identity_module_enabled boolean NOT NULL DEFAULT false,
  information_officer_name text,
  information_officer_email text,
  privacy_policy_text text,
  paia_manual_text text,
  slack_webhook text,
  teams_webhook text,
  portal_slug text NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  template_id uuid,
  module_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  vendor_approval_threshold numeric,
  terminology_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  incident_layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_sender_name text,
  trial_ends_at timestamp with time zone
);

CREATE TABLE public.business_templates (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  key text NOT NULL,
  name text NOT NULL,
  description text,
  enabled_modules text[] NOT NULL DEFAULT ARRAY['problems'::text, 'cmdb'::text, 'on_call'::text, 'service_catalog'::text, 'sla_policies'::text, 'attachments'::text, 'time_logging'::text],
  terminology jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_categories text[] NOT NULL DEFAULT ARRAY[]::text[],
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE public.org_members (
  user_id uuid NOT NULL,
  org_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'agent'::text,
  mfa_enrolled boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  resolver_group_id uuid,
  whatsapp_number text
);

CREATE TABLE public.org_invites (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  code text NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'::text),
  role text NOT NULL DEFAULT 'agent'::text,
  resolver_group_id uuid,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + '14 days'::interval),
  used_at timestamp with time zone,
  used_by uuid
);

CREATE TABLE public.resolver_groups (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  channel_slack_webhook text,
  channel_teams_webhook text,
  channel_whatsapp_group text,
  channel_sms_group text
);

CREATE TABLE public.on_call_rotations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  resolver_group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  starts_at timestamp with time zone NOT NULL,
  ends_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.categories (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  default_resolver_group_id uuid
);

CREATE TABLE public.rca_categories (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE public.statuses (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE public.severities (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  sla_minutes integer NOT NULL,
  business_weight integer NOT NULL DEFAULT 1
);

CREATE TABLE public.custom_fields (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  label text NOT NULL,
  field_type text NOT NULL DEFAULT 'text'::text,
  options text[],
  required boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.saved_views (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  filter_json jsonb NOT NULL,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.service_catalog_items (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  category_id uuid,
  default_resolver_group_id uuid,
  requires_approval boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.sla_policies (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  metric_type text NOT NULL,
  target_minutes integer NOT NULL,
  category_id uuid,
  severity_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.incidents (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  display_id text NOT NULL,
  title text NOT NULL,
  notes text,
  category_id uuid NOT NULL,
  severity_id uuid NOT NULL,
  status_id uuid,
  rca_category_id uuid,
  resolution_class text,
  sla_minutes integer NOT NULL,
  sla_paused_minutes integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'agent'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at timestamp with time zone,
  ai_mitigation text,
  created_by uuid,
  acknowledged_at timestamp with time zone,
  acknowledged_by uuid,
  escalated_at timestamp with time zone,
  record_type text NOT NULL DEFAULT 'incident'::text,
  approval_status text NOT NULL DEFAULT 'not_required'::text,
  approved_by uuid,
  approved_at timestamp with time zone,
  first_response_at timestamp with time zone
);

CREATE TABLE public.incident_timeline (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  incident_id uuid NOT NULL,
  org_id uuid NOT NULL,
  ts timestamp with time zone NOT NULL DEFAULT now(),
  status_id uuid,
  resolver_group_id uuid,
  note text
);

CREATE TABLE public.incident_comments (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  incident_id uuid NOT NULL,
  org_id uuid NOT NULL,
  author_type text NOT NULL,
  author_user_id uuid,
  visibility text NOT NULL DEFAULT 'internal'::text,
  body text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.incident_assignments (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  incident_id uuid NOT NULL,
  org_id uuid NOT NULL,
  resolver_group_id uuid,
  mode text NOT NULL DEFAULT 'parallel'::text,
  sequence_order integer NOT NULL DEFAULT 0,
  sla_minutes integer,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  assigned_user_id uuid
);

CREATE TABLE public.incident_attachments (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  storage_path text NOT NULL,
  file_name text NOT NULL,
  file_size integer NOT NULL,
  uploaded_by_type text NOT NULL DEFAULT 'staff'::text,
  uploaded_by_user_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.incident_custom_values (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  incident_id uuid NOT NULL,
  custom_field_id uuid NOT NULL,
  org_id uuid NOT NULL,
  value text
);

CREATE TABLE public.incident_identity (
  incident_id uuid NOT NULL,
  org_id uuid NOT NULL,
  customer_name text,
  customer_contact text,
  consent_given boolean NOT NULL DEFAULT false,
  consent_ts timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.incident_ack_tokens (
  token text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'::text),
  incident_id uuid NOT NULL,
  org_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  used_at timestamp with time zone
);

CREATE TABLE public.incident_customer_access (
  token text NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'::text),
  incident_id uuid NOT NULL,
  org_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- NOTE: no incident_vendor_access table exists — see header comment re: the
-- notify_vendor_of_resolution / notify_vendor_of_staff_reply bug.
CREATE TABLE public.incident_vendors (
  incident_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  org_id uuid NOT NULL
);

CREATE TABLE public.incident_cis (
  incident_id uuid NOT NULL,
  ci_id uuid NOT NULL,
  org_id uuid NOT NULL
);

CREATE TABLE public.escalations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  incident_id uuid NOT NULL,
  org_id uuid NOT NULL,
  ts timestamp with time zone NOT NULL DEFAULT now(),
  resolver_group_id uuid,
  channel text NOT NULL,
  kind text NOT NULL DEFAULT 'escalation'::text,
  delivered text
);

CREATE TABLE public.escalation_policies (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  resolver_group_id uuid NOT NULL,
  severity_id uuid,
  minutes_before_escalation integer NOT NULL DEFAULT 15,
  escalate_to_resolver_group_id uuid,
  escalate_to_email text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  notify_channel text NOT NULL DEFAULT 'email'::text,
  escalate_to_whatsapp_number text
);

CREATE TABLE public.automation_rules (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  label text NOT NULL,
  event_type text NOT NULL,
  filter_category_id uuid,
  filter_severity_id uuid,
  action_email_to text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_triggered_at timestamp with time zone,
  action_type text NOT NULL DEFAULT 'email'::text,
  filter_resolver_group_id uuid
);

CREATE TABLE public.automation_events (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  automation_type text NOT NULL,
  automation_id uuid NOT NULL,
  incident_id uuid,
  outcome text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.ambient_flag_feedback (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  flag_type text NOT NULL,
  incident_id uuid,
  action text NOT NULL,
  user_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.integration_webhooks (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  label text NOT NULL,
  url text NOT NULL,
  secret text NOT NULL,
  event_types text[] NOT NULL DEFAULT ARRAY['incident.created'::text, 'incident.resolved'::text],
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_triggered_at timestamp with time zone,
  last_status integer
);

CREATE TABLE public.api_keys (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  label text NOT NULL,
  key_hash text NOT NULL,
  key_prefix text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['create_incidents'::text],
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone,
  revoked_at timestamp with time zone
);

CREATE TABLE public.audit_log (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  actor_user_id uuid,
  ts timestamp with time zone NOT NULL DEFAULT now(),
  action text NOT NULL,
  detail text
);

CREATE TABLE public.identity_module_log (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  actor_user_id uuid,
  ts timestamp with time zone NOT NULL DEFAULT now(),
  action text NOT NULL
);

CREATE TABLE public.kb_articles (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  search_vector tsvector DEFAULT to_tsvector('english'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(body, ''::text))),
  view_count integer NOT NULL DEFAULT 0,
  helpful_count integer NOT NULL DEFAULT 0,
  not_helpful_count integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.custom_charts (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  chart_type text NOT NULL,
  metric text NOT NULL DEFAULT 'count'::text,
  group_by text NOT NULL,
  filter_status text,
  filter_range_days integer,
  filter_category_id uuid,
  filter_severity_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  filter_resolver_group_id uuid
);

CREATE TABLE public.custom_dashboards (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE TABLE public.custom_dashboard_charts (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  chart_id uuid NOT NULL,
  width text NOT NULL DEFAULT 'half'::text,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE public.problems (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  display_id text NOT NULL,
  title text NOT NULL,
  description text,
  rca_category_id uuid,
  workaround text,
  status text NOT NULL DEFAULT 'investigating'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at timestamp with time zone,
  created_by uuid
);

CREATE TABLE public.problem_incidents (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  problem_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  org_id uuid NOT NULL,
  linked_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.problem_cis (
  problem_id uuid NOT NULL,
  ci_id uuid NOT NULL,
  org_id uuid NOT NULL
);

CREATE TABLE public.preventative_actions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  incident_id uuid,
  rca_category_id uuid,
  description text NOT NULL,
  resolver_group_id uuid,
  due_date date,
  status text NOT NULL DEFAULT 'open'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  closed_at timestamp with time zone,
  closed_note text,
  problem_id uuid
);

CREATE TABLE public.rca_analyses (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  incident_id uuid,
  problem_id uuid,
  method text NOT NULL,
  problem_statement text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.ci_types (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  is_service boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE public.configuration_items (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  display_id text NOT NULL,
  name text NOT NULL,
  ci_type_id uuid,
  status text NOT NULL DEFAULT 'active'::text,
  owner_user_id uuid,
  support_group_id uuid,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_reviewed_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  lifecycle_status text DEFAULT 'deployed'::text,
  warranty_expiry date,
  license_expiry date,
  purchase_vendor_id uuid,
  purchase_id uuid
);

CREATE TABLE public.ci_relationships (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  parent_ci_id uuid NOT NULL,
  child_ci_id uuid NOT NULL,
  relationship_type text NOT NULL DEFAULT 'depends_on'::text
);

CREATE TABLE public.vendors (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  display_id text NOT NULL,
  name text NOT NULL,
  category text,
  contact_name text,
  contact_email text,
  contact_phone text,
  contract_terms text,
  status text NOT NULL DEFAULT 'active'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.vendor_purchases (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  display_id text NOT NULL,
  description text NOT NULL,
  agreed_price numeric,
  agreed_terms text,
  expected_delivery_date date,
  actual_delivery_date date,
  status text NOT NULL DEFAULT 'ordered'::text,
  approval_status text NOT NULL DEFAULT 'not_required'::text,
  approved_by uuid,
  approved_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.quote_requests (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  display_id text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open'::text,
  awarded_vendor_id uuid,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  incident_id uuid
);

CREATE TABLE public.quote_request_vendors (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  quote_request_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  org_id uuid NOT NULL,
  token text NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'::text),
  quoted_price numeric,
  notes text,
  valid_until date,
  submitted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);


-- ============================================================================
-- CONSTRAINTS (primary keys, uniques, foreign keys, checks)
-- ============================================================================

-- organisations
ALTER TABLE public.organisations ADD CONSTRAINT organisations_pkey PRIMARY KEY (id);
ALTER TABLE public.organisations ADD CONSTRAINT organisations_portal_slug_key UNIQUE (portal_slug);
ALTER TABLE public.organisations ADD CONSTRAINT organisations_template_id_fkey FOREIGN KEY (template_id) REFERENCES business_templates(id);

-- business_templates
ALTER TABLE public.business_templates ADD CONSTRAINT business_templates_pkey PRIMARY KEY (id);
ALTER TABLE public.business_templates ADD CONSTRAINT business_templates_key_key UNIQUE (key);

-- org_members
ALTER TABLE public.org_members ADD CONSTRAINT org_members_pkey PRIMARY KEY (user_id);
ALTER TABLE public.org_members ADD CONSTRAINT org_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])));
ALTER TABLE public.org_members ADD CONSTRAINT org_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.org_members ADD CONSTRAINT org_members_resolver_group_id_fkey FOREIGN KEY (resolver_group_id) REFERENCES resolver_groups(id);
ALTER TABLE public.org_members ADD CONSTRAINT org_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- org_invites
ALTER TABLE public.org_invites ADD CONSTRAINT org_invites_pkey PRIMARY KEY (id);
ALTER TABLE public.org_invites ADD CONSTRAINT org_invites_code_key UNIQUE (code);
ALTER TABLE public.org_invites ADD CONSTRAINT org_invites_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])));
ALTER TABLE public.org_invites ADD CONSTRAINT org_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.org_invites ADD CONSTRAINT org_invites_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.org_invites ADD CONSTRAINT org_invites_resolver_group_id_fkey FOREIGN KEY (resolver_group_id) REFERENCES resolver_groups(id);
ALTER TABLE public.org_invites ADD CONSTRAINT org_invites_used_by_fkey FOREIGN KEY (used_by) REFERENCES auth.users(id);

-- resolver_groups
ALTER TABLE public.resolver_groups ADD CONSTRAINT resolver_groups_pkey PRIMARY KEY (id);
ALTER TABLE public.resolver_groups ADD CONSTRAINT resolver_groups_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- on_call_rotations
ALTER TABLE public.on_call_rotations ADD CONSTRAINT on_call_rotations_pkey PRIMARY KEY (id);
ALTER TABLE public.on_call_rotations ADD CONSTRAINT on_call_rotations_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.on_call_rotations ADD CONSTRAINT on_call_rotations_resolver_group_id_fkey FOREIGN KEY (resolver_group_id) REFERENCES resolver_groups(id) ON DELETE CASCADE;
ALTER TABLE public.on_call_rotations ADD CONSTRAINT on_call_rotations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);

-- categories
ALTER TABLE public.categories ADD CONSTRAINT categories_pkey PRIMARY KEY (id);
ALTER TABLE public.categories ADD CONSTRAINT categories_default_resolver_group_id_fkey FOREIGN KEY (default_resolver_group_id) REFERENCES resolver_groups(id);
ALTER TABLE public.categories ADD CONSTRAINT categories_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- rca_categories
ALTER TABLE public.rca_categories ADD CONSTRAINT rca_categories_pkey PRIMARY KEY (id);
ALTER TABLE public.rca_categories ADD CONSTRAINT rca_categories_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- statuses
ALTER TABLE public.statuses ADD CONSTRAINT statuses_pkey PRIMARY KEY (id);
ALTER TABLE public.statuses ADD CONSTRAINT statuses_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- severities
ALTER TABLE public.severities ADD CONSTRAINT severities_pkey PRIMARY KEY (id);
ALTER TABLE public.severities ADD CONSTRAINT severities_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- custom_fields
ALTER TABLE public.custom_fields ADD CONSTRAINT custom_fields_pkey PRIMARY KEY (id);
ALTER TABLE public.custom_fields ADD CONSTRAINT custom_fields_field_type_check CHECK ((field_type = ANY (ARRAY['text'::text, 'number'::text, 'date'::text, 'select'::text, 'checkbox'::text])));
ALTER TABLE public.custom_fields ADD CONSTRAINT custom_fields_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- saved_views
ALTER TABLE public.saved_views ADD CONSTRAINT saved_views_pkey PRIMARY KEY (id);
ALTER TABLE public.saved_views ADD CONSTRAINT saved_views_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.saved_views ADD CONSTRAINT saved_views_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- service_catalog_items
ALTER TABLE public.service_catalog_items ADD CONSTRAINT service_catalog_items_pkey PRIMARY KEY (id);
ALTER TABLE public.service_catalog_items ADD CONSTRAINT service_catalog_items_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id);
ALTER TABLE public.service_catalog_items ADD CONSTRAINT service_catalog_items_default_resolver_group_id_fkey FOREIGN KEY (default_resolver_group_id) REFERENCES resolver_groups(id);
ALTER TABLE public.service_catalog_items ADD CONSTRAINT service_catalog_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- sla_policies
ALTER TABLE public.sla_policies ADD CONSTRAINT sla_policies_pkey PRIMARY KEY (id);
ALTER TABLE public.sla_policies ADD CONSTRAINT sla_policies_metric_type_check CHECK ((metric_type = ANY (ARRAY['first_response'::text, 'resolution'::text])));
ALTER TABLE public.sla_policies ADD CONSTRAINT sla_policies_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id);
ALTER TABLE public.sla_policies ADD CONSTRAINT sla_policies_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.sla_policies ADD CONSTRAINT sla_policies_severity_id_fkey FOREIGN KEY (severity_id) REFERENCES severities(id);

-- incidents
ALTER TABLE public.incidents ADD CONSTRAINT incidents_pkey PRIMARY KEY (id);
ALTER TABLE public.incidents ADD CONSTRAINT incidents_approval_status_check CHECK ((approval_status = ANY (ARRAY['not_required'::text, 'pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE public.incidents ADD CONSTRAINT incidents_record_type_check CHECK ((record_type = ANY (ARRAY['incident'::text, 'service_request'::text])));
ALTER TABLE public.incidents ADD CONSTRAINT incidents_source_check CHECK ((source = ANY (ARRAY['agent'::text, 'chatbot'::text, 'portal'::text, 'api'::text])));
ALTER TABLE public.incidents ADD CONSTRAINT incidents_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES auth.users(id);
ALTER TABLE public.incidents ADD CONSTRAINT incidents_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id);
ALTER TABLE public.incidents ADD CONSTRAINT incidents_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id);
ALTER TABLE public.incidents ADD CONSTRAINT incidents_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.incidents ADD CONSTRAINT incidents_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.incidents ADD CONSTRAINT incidents_rca_category_id_fkey FOREIGN KEY (rca_category_id) REFERENCES rca_categories(id);
ALTER TABLE public.incidents ADD CONSTRAINT incidents_severity_id_fkey FOREIGN KEY (severity_id) REFERENCES severities(id);
ALTER TABLE public.incidents ADD CONSTRAINT incidents_status_id_fkey FOREIGN KEY (status_id) REFERENCES statuses(id);

-- incident_timeline
ALTER TABLE public.incident_timeline ADD CONSTRAINT incident_timeline_pkey PRIMARY KEY (id);
ALTER TABLE public.incident_timeline ADD CONSTRAINT incident_timeline_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.incident_timeline ADD CONSTRAINT incident_timeline_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.incident_timeline ADD CONSTRAINT incident_timeline_resolver_group_id_fkey FOREIGN KEY (resolver_group_id) REFERENCES resolver_groups(id);
ALTER TABLE public.incident_timeline ADD CONSTRAINT incident_timeline_status_id_fkey FOREIGN KEY (status_id) REFERENCES statuses(id);

-- incident_comments
ALTER TABLE public.incident_comments ADD CONSTRAINT incident_comments_pkey PRIMARY KEY (id);
ALTER TABLE public.incident_comments ADD CONSTRAINT incident_comments_author_type_check CHECK ((author_type = ANY (ARRAY['staff'::text, 'customer'::text, 'system'::text])));
ALTER TABLE public.incident_comments ADD CONSTRAINT incident_comments_visibility_check CHECK ((visibility = ANY (ARRAY['internal'::text, 'customer'::text])));
ALTER TABLE public.incident_comments ADD CONSTRAINT incident_comments_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES auth.users(id);
ALTER TABLE public.incident_comments ADD CONSTRAINT incident_comments_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.incident_comments ADD CONSTRAINT incident_comments_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
-- NOTE: visibility check does not include 'vendor', even though app code /
-- notify_vendor_of_staff_reply() reference a visibility = 'vendor' case.

-- incident_assignments
ALTER TABLE public.incident_assignments ADD CONSTRAINT incident_assignments_pkey PRIMARY KEY (id);
ALTER TABLE public.incident_assignments ADD CONSTRAINT incident_assignments_mode_check CHECK ((mode = ANY (ARRAY['parallel'::text, 'sequential'::text])));
ALTER TABLE public.incident_assignments ADD CONSTRAINT incident_assignments_assigned_user_id_fkey FOREIGN KEY (assigned_user_id) REFERENCES auth.users(id);
ALTER TABLE public.incident_assignments ADD CONSTRAINT incident_assignments_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.incident_assignments ADD CONSTRAINT incident_assignments_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.incident_assignments ADD CONSTRAINT incident_assignments_resolver_group_id_fkey FOREIGN KEY (resolver_group_id) REFERENCES resolver_groups(id);

-- incident_attachments
ALTER TABLE public.incident_attachments ADD CONSTRAINT incident_attachments_pkey PRIMARY KEY (id);
ALTER TABLE public.incident_attachments ADD CONSTRAINT incident_attachments_uploaded_by_type_check CHECK ((uploaded_by_type = ANY (ARRAY['staff'::text, 'customer'::text])));
ALTER TABLE public.incident_attachments ADD CONSTRAINT incident_attachments_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.incident_attachments ADD CONSTRAINT incident_attachments_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.incident_attachments ADD CONSTRAINT incident_attachments_uploaded_by_user_id_fkey FOREIGN KEY (uploaded_by_user_id) REFERENCES auth.users(id);

-- incident_custom_values
ALTER TABLE public.incident_custom_values ADD CONSTRAINT incident_custom_values_pkey PRIMARY KEY (id);
ALTER TABLE public.incident_custom_values ADD CONSTRAINT incident_custom_values_incident_id_custom_field_id_key UNIQUE (incident_id, custom_field_id);
ALTER TABLE public.incident_custom_values ADD CONSTRAINT incident_custom_values_custom_field_id_fkey FOREIGN KEY (custom_field_id) REFERENCES custom_fields(id) ON DELETE CASCADE;
ALTER TABLE public.incident_custom_values ADD CONSTRAINT incident_custom_values_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.incident_custom_values ADD CONSTRAINT incident_custom_values_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- incident_identity
ALTER TABLE public.incident_identity ADD CONSTRAINT incident_identity_pkey PRIMARY KEY (incident_id);
ALTER TABLE public.incident_identity ADD CONSTRAINT incident_identity_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.incident_identity ADD CONSTRAINT incident_identity_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- incident_ack_tokens
ALTER TABLE public.incident_ack_tokens ADD CONSTRAINT incident_ack_tokens_pkey PRIMARY KEY (token);
ALTER TABLE public.incident_ack_tokens ADD CONSTRAINT incident_ack_tokens_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.incident_ack_tokens ADD CONSTRAINT incident_ack_tokens_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- incident_customer_access
ALTER TABLE public.incident_customer_access ADD CONSTRAINT incident_customer_access_pkey PRIMARY KEY (token);
ALTER TABLE public.incident_customer_access ADD CONSTRAINT incident_customer_access_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.incident_customer_access ADD CONSTRAINT incident_customer_access_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- incident_vendors
ALTER TABLE public.incident_vendors ADD CONSTRAINT incident_vendors_pkey PRIMARY KEY (incident_id, vendor_id);
ALTER TABLE public.incident_vendors ADD CONSTRAINT incident_vendors_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.incident_vendors ADD CONSTRAINT incident_vendors_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.incident_vendors ADD CONSTRAINT incident_vendors_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE;

-- incident_cis
ALTER TABLE public.incident_cis ADD CONSTRAINT incident_cis_pkey PRIMARY KEY (incident_id, ci_id);
ALTER TABLE public.incident_cis ADD CONSTRAINT incident_cis_ci_id_fkey FOREIGN KEY (ci_id) REFERENCES configuration_items(id) ON DELETE CASCADE;
ALTER TABLE public.incident_cis ADD CONSTRAINT incident_cis_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.incident_cis ADD CONSTRAINT incident_cis_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- escalations
ALTER TABLE public.escalations ADD CONSTRAINT escalations_pkey PRIMARY KEY (id);
ALTER TABLE public.escalations ADD CONSTRAINT escalations_kind_check CHECK ((kind = ANY (ARRAY['escalation'::text, 'war_room'::text])));
ALTER TABLE public.escalations ADD CONSTRAINT escalations_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.escalations ADD CONSTRAINT escalations_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.escalations ADD CONSTRAINT escalations_resolver_group_id_fkey FOREIGN KEY (resolver_group_id) REFERENCES resolver_groups(id);

-- escalation_policies
ALTER TABLE public.escalation_policies ADD CONSTRAINT escalation_policies_pkey PRIMARY KEY (id);
ALTER TABLE public.escalation_policies ADD CONSTRAINT escalation_policies_notify_channel_check CHECK ((notify_channel = ANY (ARRAY['email'::text, 'whatsapp'::text])));
ALTER TABLE public.escalation_policies ADD CONSTRAINT escalation_policies_escalate_to_resolver_group_id_fkey FOREIGN KEY (escalate_to_resolver_group_id) REFERENCES resolver_groups(id);
ALTER TABLE public.escalation_policies ADD CONSTRAINT escalation_policies_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.escalation_policies ADD CONSTRAINT escalation_policies_resolver_group_id_fkey FOREIGN KEY (resolver_group_id) REFERENCES resolver_groups(id) ON DELETE CASCADE;
ALTER TABLE public.escalation_policies ADD CONSTRAINT escalation_policies_severity_id_fkey FOREIGN KEY (severity_id) REFERENCES severities(id);

-- automation_rules
ALTER TABLE public.automation_rules ADD CONSTRAINT automation_rules_pkey PRIMARY KEY (id);
ALTER TABLE public.automation_rules ADD CONSTRAINT automation_rules_action_type_check CHECK ((action_type = ANY (ARRAY['email'::text, 'slack'::text, 'teams'::text])));
ALTER TABLE public.automation_rules ADD CONSTRAINT automation_rules_event_type_check CHECK ((event_type = ANY (ARRAY['incident.created'::text, 'incident.resolved'::text, 'incident.status_changed'::text])));
ALTER TABLE public.automation_rules ADD CONSTRAINT automation_rules_filter_category_id_fkey FOREIGN KEY (filter_category_id) REFERENCES categories(id);
ALTER TABLE public.automation_rules ADD CONSTRAINT automation_rules_filter_resolver_group_id_fkey FOREIGN KEY (filter_resolver_group_id) REFERENCES resolver_groups(id);
ALTER TABLE public.automation_rules ADD CONSTRAINT automation_rules_filter_severity_id_fkey FOREIGN KEY (filter_severity_id) REFERENCES severities(id);
ALTER TABLE public.automation_rules ADD CONSTRAINT automation_rules_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- automation_events
ALTER TABLE public.automation_events ADD CONSTRAINT automation_events_pkey PRIMARY KEY (id);
ALTER TABLE public.automation_events ADD CONSTRAINT automation_events_automation_type_check CHECK ((automation_type = ANY (ARRAY['automation_rule'::text, 'escalation_policy'::text, 'custom_agent'::text])));
ALTER TABLE public.automation_events ADD CONSTRAINT automation_events_outcome_check CHECK ((outcome = ANY (ARRAY['fired_no_objection'::text, 'fired_then_reverted'::text, 'proposed_confirmed'::text, 'proposed_rejected'::text])));
ALTER TABLE public.automation_events ADD CONSTRAINT automation_events_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE SET NULL;
ALTER TABLE public.automation_events ADD CONSTRAINT automation_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- ambient_flag_feedback
ALTER TABLE public.ambient_flag_feedback ADD CONSTRAINT ambient_flag_feedback_pkey PRIMARY KEY (id);
ALTER TABLE public.ambient_flag_feedback ADD CONSTRAINT ambient_flag_feedback_action_check CHECK ((action = ANY (ARRAY['dismissed'::text, 'acted'::text])));
ALTER TABLE public.ambient_flag_feedback ADD CONSTRAINT ambient_flag_feedback_flag_type_check CHECK ((flag_type = ANY (ARRAY['newly_breaching'::text, 'ready_to_close'::text])));
ALTER TABLE public.ambient_flag_feedback ADD CONSTRAINT ambient_flag_feedback_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE SET NULL;
ALTER TABLE public.ambient_flag_feedback ADD CONSTRAINT ambient_flag_feedback_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.ambient_flag_feedback ADD CONSTRAINT ambient_flag_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);

-- integration_webhooks
ALTER TABLE public.integration_webhooks ADD CONSTRAINT integration_webhooks_pkey PRIMARY KEY (id);
ALTER TABLE public.integration_webhooks ADD CONSTRAINT integration_webhooks_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- api_keys
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- audit_log
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id);
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- identity_module_log
ALTER TABLE public.identity_module_log ADD CONSTRAINT identity_module_log_pkey PRIMARY KEY (id);
ALTER TABLE public.identity_module_log ADD CONSTRAINT identity_module_log_action_check CHECK ((action = ANY (ARRAY['enabled'::text, 'disabled'::text])));
ALTER TABLE public.identity_module_log ADD CONSTRAINT identity_module_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id);
ALTER TABLE public.identity_module_log ADD CONSTRAINT identity_module_log_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- kb_articles
ALTER TABLE public.kb_articles ADD CONSTRAINT kb_articles_pkey PRIMARY KEY (id);
ALTER TABLE public.kb_articles ADD CONSTRAINT kb_articles_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.kb_articles ADD CONSTRAINT kb_articles_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- custom_charts
ALTER TABLE public.custom_charts ADD CONSTRAINT custom_charts_pkey PRIMARY KEY (id);
ALTER TABLE public.custom_charts ADD CONSTRAINT custom_charts_chart_type_check CHECK ((chart_type = ANY (ARRAY['bar'::text, 'line'::text, 'pie'::text])));
ALTER TABLE public.custom_charts ADD CONSTRAINT custom_charts_group_by_check CHECK ((group_by = ANY (ARRAY['category'::text, 'severity'::text, 'status'::text, 'rca_category'::text, 'resolver_group'::text, 'source'::text, 'month'::text, 'week'::text])));
ALTER TABLE public.custom_charts ADD CONSTRAINT custom_charts_metric_check CHECK ((metric = ANY (ARRAY['count'::text, 'avg_resolution_hours'::text, 'breach_rate'::text])));
ALTER TABLE public.custom_charts ADD CONSTRAINT custom_charts_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.custom_charts ADD CONSTRAINT custom_charts_filter_category_id_fkey FOREIGN KEY (filter_category_id) REFERENCES categories(id);
ALTER TABLE public.custom_charts ADD CONSTRAINT custom_charts_filter_resolver_group_id_fkey FOREIGN KEY (filter_resolver_group_id) REFERENCES resolver_groups(id);
ALTER TABLE public.custom_charts ADD CONSTRAINT custom_charts_filter_severity_id_fkey FOREIGN KEY (filter_severity_id) REFERENCES severities(id);
ALTER TABLE public.custom_charts ADD CONSTRAINT custom_charts_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- custom_dashboards
ALTER TABLE public.custom_dashboards ADD CONSTRAINT custom_dashboards_pkey PRIMARY KEY (id);
ALTER TABLE public.custom_dashboards ADD CONSTRAINT custom_dashboards_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.custom_dashboards ADD CONSTRAINT custom_dashboards_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- custom_dashboard_charts
ALTER TABLE public.custom_dashboard_charts ADD CONSTRAINT custom_dashboard_charts_pkey PRIMARY KEY (id);
ALTER TABLE public.custom_dashboard_charts ADD CONSTRAINT custom_dashboard_charts_width_check CHECK ((width = ANY (ARRAY['half'::text, 'full'::text])));
ALTER TABLE public.custom_dashboard_charts ADD CONSTRAINT custom_dashboard_charts_chart_id_fkey FOREIGN KEY (chart_id) REFERENCES custom_charts(id) ON DELETE CASCADE;
ALTER TABLE public.custom_dashboard_charts ADD CONSTRAINT custom_dashboard_charts_dashboard_id_fkey FOREIGN KEY (dashboard_id) REFERENCES custom_dashboards(id) ON DELETE CASCADE;
ALTER TABLE public.custom_dashboard_charts ADD CONSTRAINT custom_dashboard_charts_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- problems
ALTER TABLE public.problems ADD CONSTRAINT problems_pkey PRIMARY KEY (id);
ALTER TABLE public.problems ADD CONSTRAINT problems_status_check CHECK ((status = ANY (ARRAY['investigating'::text, 'known_error'::text, 'resolved'::text, 'closed'::text])));
ALTER TABLE public.problems ADD CONSTRAINT problems_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.problems ADD CONSTRAINT problems_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.problems ADD CONSTRAINT problems_rca_category_id_fkey FOREIGN KEY (rca_category_id) REFERENCES rca_categories(id);

-- problem_incidents
ALTER TABLE public.problem_incidents ADD CONSTRAINT problem_incidents_pkey PRIMARY KEY (id);
ALTER TABLE public.problem_incidents ADD CONSTRAINT problem_incidents_problem_id_incident_id_key UNIQUE (problem_id, incident_id);
ALTER TABLE public.problem_incidents ADD CONSTRAINT problem_incidents_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.problem_incidents ADD CONSTRAINT problem_incidents_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.problem_incidents ADD CONSTRAINT problem_incidents_problem_id_fkey FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE;

-- problem_cis
ALTER TABLE public.problem_cis ADD CONSTRAINT problem_cis_pkey PRIMARY KEY (problem_id, ci_id);
ALTER TABLE public.problem_cis ADD CONSTRAINT problem_cis_ci_id_fkey FOREIGN KEY (ci_id) REFERENCES configuration_items(id) ON DELETE CASCADE;
ALTER TABLE public.problem_cis ADD CONSTRAINT problem_cis_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.problem_cis ADD CONSTRAINT problem_cis_problem_id_fkey FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE;

-- preventative_actions
ALTER TABLE public.preventative_actions ADD CONSTRAINT preventative_actions_pkey PRIMARY KEY (id);
ALTER TABLE public.preventative_actions ADD CONSTRAINT preventative_actions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'done'::text, 'wont_fix'::text])));
ALTER TABLE public.preventative_actions ADD CONSTRAINT preventative_actions_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE SET NULL;
ALTER TABLE public.preventative_actions ADD CONSTRAINT preventative_actions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.preventative_actions ADD CONSTRAINT preventative_actions_problem_id_fkey FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE;
ALTER TABLE public.preventative_actions ADD CONSTRAINT preventative_actions_rca_category_id_fkey FOREIGN KEY (rca_category_id) REFERENCES rca_categories(id);
ALTER TABLE public.preventative_actions ADD CONSTRAINT preventative_actions_resolver_group_id_fkey FOREIGN KEY (resolver_group_id) REFERENCES resolver_groups(id);

-- rca_analyses
ALTER TABLE public.rca_analyses ADD CONSTRAINT rca_analyses_pkey PRIMARY KEY (id);
ALTER TABLE public.rca_analyses ADD CONSTRAINT rca_analyses_check CHECK (((incident_id IS NOT NULL) OR (problem_id IS NOT NULL)));
ALTER TABLE public.rca_analyses ADD CONSTRAINT rca_analyses_method_check CHECK ((method = ANY (ARRAY['five_whys'::text, 'fishbone'::text])));
ALTER TABLE public.rca_analyses ADD CONSTRAINT rca_analyses_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.rca_analyses ADD CONSTRAINT rca_analyses_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE;
ALTER TABLE public.rca_analyses ADD CONSTRAINT rca_analyses_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.rca_analyses ADD CONSTRAINT rca_analyses_problem_id_fkey FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE;

-- ci_types
ALTER TABLE public.ci_types ADD CONSTRAINT ci_types_pkey PRIMARY KEY (id);
ALTER TABLE public.ci_types ADD CONSTRAINT ci_types_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- configuration_items
ALTER TABLE public.configuration_items ADD CONSTRAINT configuration_items_pkey PRIMARY KEY (id);
ALTER TABLE public.configuration_items ADD CONSTRAINT configuration_items_lifecycle_status_check CHECK ((lifecycle_status = ANY (ARRAY['procured'::text, 'deployed'::text, 'in_maintenance'::text, 'disposed'::text])));
ALTER TABLE public.configuration_items ADD CONSTRAINT configuration_items_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text])));
ALTER TABLE public.configuration_items ADD CONSTRAINT configuration_items_ci_type_id_fkey FOREIGN KEY (ci_type_id) REFERENCES ci_types(id);
ALTER TABLE public.configuration_items ADD CONSTRAINT configuration_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.configuration_items ADD CONSTRAINT configuration_items_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id);
ALTER TABLE public.configuration_items ADD CONSTRAINT configuration_items_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES vendor_purchases(id);
ALTER TABLE public.configuration_items ADD CONSTRAINT configuration_items_purchase_vendor_id_fkey FOREIGN KEY (purchase_vendor_id) REFERENCES vendors(id);
ALTER TABLE public.configuration_items ADD CONSTRAINT configuration_items_support_group_id_fkey FOREIGN KEY (support_group_id) REFERENCES resolver_groups(id);

-- ci_relationships
ALTER TABLE public.ci_relationships ADD CONSTRAINT ci_relationships_pkey PRIMARY KEY (id);
ALTER TABLE public.ci_relationships ADD CONSTRAINT ci_relationships_parent_ci_id_child_ci_id_relationship_type_key UNIQUE (parent_ci_id, child_ci_id, relationship_type);
ALTER TABLE public.ci_relationships ADD CONSTRAINT ci_relationships_relationship_type_check CHECK ((relationship_type = ANY (ARRAY['depends_on'::text, 'runs_on'::text, 'part_of'::text, 'connects_to'::text])));
ALTER TABLE public.ci_relationships ADD CONSTRAINT ci_relationships_child_ci_id_fkey FOREIGN KEY (child_ci_id) REFERENCES configuration_items(id) ON DELETE CASCADE;
ALTER TABLE public.ci_relationships ADD CONSTRAINT ci_relationships_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.ci_relationships ADD CONSTRAINT ci_relationships_parent_ci_id_fkey FOREIGN KEY (parent_ci_id) REFERENCES configuration_items(id) ON DELETE CASCADE;

-- vendors
ALTER TABLE public.vendors ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);
ALTER TABLE public.vendors ADD CONSTRAINT vendors_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])));
ALTER TABLE public.vendors ADD CONSTRAINT vendors_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- vendor_purchases
ALTER TABLE public.vendor_purchases ADD CONSTRAINT vendor_purchases_pkey PRIMARY KEY (id);
ALTER TABLE public.vendor_purchases ADD CONSTRAINT vendor_purchases_approval_status_check CHECK ((approval_status = ANY (ARRAY['not_required'::text, 'pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE public.vendor_purchases ADD CONSTRAINT vendor_purchases_status_check CHECK ((status = ANY (ARRAY['ordered'::text, 'delivered'::text, 'disputed'::text, 'cancelled'::text])));
ALTER TABLE public.vendor_purchases ADD CONSTRAINT vendor_purchases_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id);
ALTER TABLE public.vendor_purchases ADD CONSTRAINT vendor_purchases_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.vendor_purchases ADD CONSTRAINT vendor_purchases_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.vendor_purchases ADD CONSTRAINT vendor_purchases_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE;

-- quote_requests
ALTER TABLE public.quote_requests ADD CONSTRAINT quote_requests_pkey PRIMARY KEY (id);
ALTER TABLE public.quote_requests ADD CONSTRAINT quote_requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'awarded'::text, 'cancelled'::text])));
ALTER TABLE public.quote_requests ADD CONSTRAINT quote_requests_awarded_vendor_id_fkey FOREIGN KEY (awarded_vendor_id) REFERENCES vendors(id);
ALTER TABLE public.quote_requests ADD CONSTRAINT quote_requests_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.quote_requests ADD CONSTRAINT quote_requests_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE SET NULL;
ALTER TABLE public.quote_requests ADD CONSTRAINT quote_requests_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;

-- quote_request_vendors
ALTER TABLE public.quote_request_vendors ADD CONSTRAINT quote_request_vendors_pkey PRIMARY KEY (id);
ALTER TABLE public.quote_request_vendors ADD CONSTRAINT quote_request_vendors_quote_request_id_vendor_id_key UNIQUE (quote_request_id, vendor_id);
ALTER TABLE public.quote_request_vendors ADD CONSTRAINT quote_request_vendors_token_key UNIQUE (token);
ALTER TABLE public.quote_request_vendors ADD CONSTRAINT quote_request_vendors_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE public.quote_request_vendors ADD CONSTRAINT quote_request_vendors_quote_request_id_fkey FOREIGN KEY (quote_request_id) REFERENCES quote_requests(id) ON DELETE CASCADE;
ALTER TABLE public.quote_request_vendors ADD CONSTRAINT quote_request_vendors_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE;


-- ============================================================================
-- INDEXES (beyond those backing primary/unique constraints above)
-- ============================================================================

CREATE INDEX ambient_flag_feedback_org_id_flag_type_created_at_idx ON public.ambient_flag_feedback USING btree (org_id, flag_type, created_at DESC);
CREATE INDEX api_keys_org_id_idx ON public.api_keys USING btree (org_id);
CREATE INDEX audit_log_org_id_ts_idx ON public.audit_log USING btree (org_id, ts DESC);
CREATE INDEX automation_events_automation_type_automation_id_idx ON public.automation_events USING btree (automation_type, automation_id);
CREATE INDEX automation_events_org_id_idx ON public.automation_events USING btree (org_id);
CREATE INDEX automation_rules_org_id_idx ON public.automation_rules USING btree (org_id);
CREATE INDEX configuration_items_org_id_idx ON public.configuration_items USING btree (org_id);
CREATE INDEX custom_charts_org_id_idx ON public.custom_charts USING btree (org_id);
CREATE INDEX custom_dashboard_charts_dashboard_id_idx ON public.custom_dashboard_charts USING btree (dashboard_id);
CREATE INDEX custom_dashboards_org_id_idx ON public.custom_dashboards USING btree (org_id);
CREATE INDEX custom_fields_org_id_idx ON public.custom_fields USING btree (org_id);
CREATE INDEX escalation_policies_org_id_idx ON public.escalation_policies USING btree (org_id);
CREATE INDEX escalations_incident_id_idx ON public.escalations USING btree (incident_id);
CREATE INDEX incident_assignments_incident_id_idx ON public.incident_assignments USING btree (incident_id);
CREATE INDEX incident_attachments_incident_id_idx ON public.incident_attachments USING btree (incident_id);
CREATE INDEX incident_attachments_org_id_idx ON public.incident_attachments USING btree (org_id);
CREATE INDEX incident_comments_incident_id_idx ON public.incident_comments USING btree (incident_id);
CREATE INDEX incident_comments_org_id_idx ON public.incident_comments USING btree (org_id);
CREATE INDEX incident_custom_values_incident_id_idx ON public.incident_custom_values USING btree (incident_id);
CREATE INDEX incident_custom_values_org_id_idx ON public.incident_custom_values USING btree (org_id);
CREATE INDEX incident_timeline_incident_id_idx ON public.incident_timeline USING btree (incident_id);
CREATE INDEX incidents_org_id_idx ON public.incidents USING btree (org_id);
CREATE INDEX incidents_org_id_rca_category_id_idx ON public.incidents USING btree (org_id, rca_category_id);
CREATE INDEX incidents_org_id_resolved_at_idx ON public.incidents USING btree (org_id, resolved_at);
CREATE INDEX incidents_org_id_source_idx ON public.incidents USING btree (org_id, source);
CREATE INDEX integration_webhooks_org_id_idx ON public.integration_webhooks USING btree (org_id);
CREATE INDEX kb_articles_org_id_idx ON public.kb_articles USING btree (org_id);
CREATE INDEX kb_articles_search_idx ON public.kb_articles USING gin (search_vector);
CREATE INDEX on_call_rotations_org_id_resolver_group_id_idx ON public.on_call_rotations USING btree (org_id, resolver_group_id);
CREATE INDEX org_invites_org_id_idx ON public.org_invites USING btree (org_id);
CREATE INDEX preventative_actions_incident_id_idx ON public.preventative_actions USING btree (incident_id);
CREATE INDEX preventative_actions_org_id_idx ON public.preventative_actions USING btree (org_id);
CREATE INDEX preventative_actions_org_id_status_idx ON public.preventative_actions USING btree (org_id, status);
CREATE INDEX problem_incidents_incident_id_idx ON public.problem_incidents USING btree (incident_id);
CREATE INDEX problem_incidents_problem_id_idx ON public.problem_incidents USING btree (problem_id);
CREATE INDEX problems_org_id_idx ON public.problems USING btree (org_id);
CREATE INDEX quote_request_vendors_quote_request_id_idx ON public.quote_request_vendors USING btree (quote_request_id);
CREATE INDEX quote_requests_incident_idx ON public.quote_requests USING btree (incident_id);
CREATE INDEX quote_requests_org_id_idx ON public.quote_requests USING btree (org_id);
CREATE INDEX rca_analyses_incident_id_idx ON public.rca_analyses USING btree (incident_id);
CREATE INDEX rca_analyses_org_id_idx ON public.rca_analyses USING btree (org_id);
CREATE INDEX rca_analyses_problem_id_idx ON public.rca_analyses USING btree (problem_id);
CREATE INDEX saved_views_org_id_idx ON public.saved_views USING btree (org_id);
CREATE INDEX service_catalog_items_org_id_idx ON public.service_catalog_items USING btree (org_id);
CREATE INDEX sla_policies_org_id_idx ON public.sla_policies USING btree (org_id);
CREATE INDEX vendor_purchases_org_id_idx ON public.vendor_purchases USING btree (org_id);
CREATE INDEX vendor_purchases_vendor_id_idx ON public.vendor_purchases USING btree (vendor_id);
CREATE INDEX vendors_org_id_idx ON public.vendors USING btree (org_id);


-- ============================================================================
-- VIEWS
-- ============================================================================

CREATE VIEW public.incident_sla_report AS
 SELECT i.org_id,
    i.display_id,
    i.title,
    cat.name AS category,
    sev.name AS severity,
    st.name AS status,
    i.source,
    i.created_at,
    i.resolved_at,
    i.sla_minutes,
    ((EXTRACT(epoch FROM (COALESCE(i.resolved_at, now()) - i.created_at)) / (60)::numeric))::integer AS minutes_open,
        CASE
            WHEN (i.resolved_at IS NOT NULL) THEN (i.resolved_at > (i.created_at + ((i.sla_minutes || ' minutes'::text))::interval))
            ELSE (now() > (i.created_at + ((i.sla_minutes || ' minutes'::text))::interval))
        END AS breached,
    rca.name AS rca_category,
    i.resolution_class
   FROM (((( incidents i
     LEFT JOIN categories cat ON ((cat.id = i.category_id)))
     LEFT JOIN severities sev ON ((sev.id = i.severity_id)))
     LEFT JOIN statuses st ON ((st.id = i.status_id)))
     LEFT JOIN rca_categories rca ON ((rca.id = i.rca_category_id)));

CREATE VIEW public.automation_trust_tiers AS
 SELECT automation_type,
    automation_id,
    org_id,
    count(*) FILTER (WHERE (created_at > (now() - '30 days'::interval))) AS recent_events,
    count(*) FILTER (WHERE ((created_at > (now() - '30 days'::interval)) AND (outcome = ANY (ARRAY['fired_no_objection'::text, 'proposed_confirmed'::text])))) AS recent_positive,
        CASE
            WHEN (count(*) FILTER (WHERE (created_at > (now() - '30 days'::interval))) < 5) THEN 'new'::text
            WHEN (count(*) FILTER (WHERE ((created_at > (now() - '7 days'::interval)) AND (outcome = ANY (ARRAY['fired_then_reverted'::text, 'proposed_rejected'::text])))) >= 2) THEN 'needs_review'::text
            WHEN (((count(*) FILTER (WHERE ((created_at > (now() - '30 days'::interval)) AND (outcome = ANY (ARRAY['fired_no_objection'::text, 'proposed_confirmed'::text])))))::double precision / (NULLIF(count(*) FILTER (WHERE (created_at > (now() - '30 days'::interval))), 0))::double precision) >= (0.9)::double precision) THEN 'trusted'::text
            ELSE 'building_trust'::text
        END AS tier
   FROM automation_events
  GROUP BY automation_type, automation_id, org_id;

CREATE VIEW public.rca_category_trends AS
 WITH recent AS (
         SELECT incidents.rca_category_id,
            count(*) AS recent_count
           FROM incidents
          WHERE ((incidents.rca_category_id IS NOT NULL) AND (incidents.created_at > (now() - '30 days'::interval)))
          GROUP BY incidents.rca_category_id
        ), prior AS (
         SELECT incidents.rca_category_id,
            count(*) AS prior_count
           FROM incidents
          WHERE ((incidents.rca_category_id IS NOT NULL) AND ((incidents.created_at >= (now() - '60 days'::interval)) AND (incidents.created_at <= (now() - '30 days'::interval))))
          GROUP BY incidents.rca_category_id
        )
 SELECT COALESCE(recent.rca_category_id, prior.rca_category_id) AS rca_category_id,
    o.id AS org_id,
    COALESCE(recent.recent_count, (0)::bigint) AS recent_count,
    COALESCE(prior.prior_count, (0)::bigint) AS prior_count,
        CASE
            WHEN ((COALESCE(prior.prior_count, (0)::bigint) = 0) AND (COALESCE(recent.recent_count, (0)::bigint) = 0)) THEN 'no_data'::text
            WHEN (COALESCE(prior.prior_count, (0)::bigint) = 0) THEN 'new_pattern'::text
            WHEN ((COALESCE(recent.recent_count, (0)::bigint))::double precision <= ((COALESCE(prior.prior_count, (0)::bigint))::double precision * (0.7)::double precision)) THEN 'improving'::text
            WHEN ((COALESCE(recent.recent_count, (0)::bigint))::double precision >= ((COALESCE(prior.prior_count, (0)::bigint))::double precision * (1.3)::double precision)) THEN 'worsening'::text
            ELSE 'stable'::text
        END AS trend
   FROM (((recent
     FULL JOIN prior ON ((prior.rca_category_id = recent.rca_category_id)))
     JOIN rca_categories rc ON ((rc.id = COALESCE(recent.rca_category_id, prior.rca_category_id))))
     JOIN organisations o ON ((o.id = rc.org_id)));


-- ============================================================================
-- FUNCTIONS
-- ----------------------------------------------------------------------------
-- Ordered roughly: auth/org context helpers, then onboarding/invites, then
-- the public-facing token-gated RPCs (portal/track/ack/vendor/quote), then
-- the api_* integration RPCs, then admin RPCs, then trigger functions.
-- ============================================================================

-- ---- context / auth helpers ----

CREATE OR REPLACE FUNCTION public.current_org_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select org_id from org_members where user_id = auth.uid()
$function$;

CREATE OR REPLACE FUNCTION public.current_org_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select role from org_members where user_id = auth.uid()
$function$;

CREATE OR REPLACE FUNCTION public.identity_module_is_on()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select coalesce(identity_module_enabled, false) from organisations where id = current_org_id()
$function$;

CREATE OR REPLACE FUNCTION public.effective_terminology(target_org_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(bt.terminology, '{}'::jsonb) || coalesce(o.terminology_overrides, '{}'::jsonb)
  from organisations o
  left join business_templates bt on bt.id = o.template_id
  where o.id = target_org_id;
$function$;

CREATE OR REPLACE FUNCTION public.redact_pii(input text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  out_text text;
begin
  if input is null then return input; end if;
  out_text := input;
  out_text := regexp_replace(out_text, '[\w.+-]+@[\w-]+\.[\w.-]+', '[redacted-email]', 'g');
  out_text := regexp_replace(out_text, '\y0\d{9}\y', '[redacted-phone]', 'g');
  out_text := regexp_replace(out_text, '\+27\d{9}\y', '[redacted-phone]', 'g');
  out_text := regexp_replace(out_text, '\y\d{2}[01]\d[0-3]\d{8}\y', '[redacted-id-number]', 'g');
  out_text := regexp_replace(out_text, '\y(?:\d[ -]?){13,19}\y', '[redacted-card-number]', 'g');
  return out_text;
end;
$function$;

CREATE OR REPLACE FUNCTION public.current_on_call(group_id uuid)
 RETURNS TABLE(user_id uuid, email text)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select r.user_id, u.email from on_call_rotations r
  join auth.users u on u.id = r.user_id
  where r.resolver_group_id = group_id and r.org_id = current_org_id()
    and now() between r.starts_at and r.ends_at
  order by r.starts_at desc
  limit 1;
$function$;

-- ---- onboarding / org membership ----

CREATE OR REPLACE FUNCTION public.create_organisation_and_owner(org_name text, org_language text DEFAULT 'en'::text, template_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  new_org_id uuid;
  selected_template record;
  cat_name text;
begin
  if exists (select 1 from org_members where user_id = auth.uid()) then
    raise exception 'This account is already linked to an organisation.';
  end if;

  select * into selected_template from business_templates where key = coalesce(template_key, 'it_full');
  if selected_template is null then
    select * into selected_template from business_templates where key = 'it_full';
  end if;

  insert into organisations (name, language, template_id, trial_ends_at)
  values (org_name, org_language, selected_template.id, now() + interval '30 days')
  returning id into new_org_id;
  insert into org_members (user_id, org_id, role) values (auth.uid(), new_org_id, 'owner');

  insert into resolver_groups (org_id, name) values
    (new_org_id, 'IT'), (new_org_id, 'Network'), (new_org_id, 'Facilities'),
    (new_org_id, 'HR'), (new_org_id, 'Vendor Management');

  if selected_template.default_categories is not null and array_length(selected_template.default_categories, 1) > 0 then
    foreach cat_name in array selected_template.default_categories loop
      insert into categories (org_id, name) values (new_org_id, cat_name);
    end loop;
  else
    insert into categories (org_id, name) values
      (new_org_id, 'Hardware'), (new_org_id, 'Software'), (new_org_id, 'Network'),
      (new_org_id, 'Access & Security'), (new_org_id, 'Facilities'), (new_org_id, 'Other');
  end if;

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
  values (new_org_id, auth.uid(), 'org_created', 'Organisation created and seeded with defaults (template: ' || selected_template.name || ')');

  return new_org_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_invite(invite_role text DEFAULT 'agent'::text, target_group_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(code text, invite_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  my_org uuid;
  my_role text;
  new_code text;
  new_id uuid;
begin
  select org_id, role into my_org, my_role from org_members where user_id = auth.uid();
  if my_role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can invite team members.';
  end if;

  insert into org_invites (org_id, role, resolver_group_id, created_by)
  values (my_org, invite_role, target_group_id, auth.uid())
  returning org_invites.code, org_invites.id into new_code, new_id;

  insert into audit_log (org_id, actor_user_id, action, detail)
  values (my_org, auth.uid(), 'invite_created', 'Invite created for role: ' || invite_role);

  return query select new_code, new_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.preview_invite(invite_code text)
 RETURNS TABLE(org_name text, role text, valid boolean)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select o.name, i.role, (i.used_at is null and i.expires_at > now())
  from org_invites i
  join organisations o on o.id = i.org_id
  where i.code = invite_code;
$function$;

CREATE OR REPLACE FUNCTION public.join_via_invite(invite_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  rec record;
begin
  if exists (select 1 from org_members where user_id = auth.uid()) then
    raise exception 'This account already belongs to an organisation.';
  end if;

  select * into rec from org_invites
  where code = invite_code and used_at is null and expires_at > now();
  if rec is null then
    raise exception 'This invite link is invalid or has expired.';
  end if;

  insert into org_members (user_id, org_id, role, resolver_group_id)
  values (auth.uid(), rec.org_id, rec.role, rec.resolver_group_id);

  update org_invites set used_at = now(), used_by = auth.uid() where id = rec.id;

  insert into audit_log (org_id, actor_user_id, action, detail)
  values (rec.org_id, auth.uid(), 'member_joined', 'Joined via invite');

  return rec.org_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_invite(target_invite_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  my_org uuid;
  my_role text;
begin
  select org_id, role into my_org, my_role from org_members where user_id = auth.uid();
  if my_role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can revoke an invite.';
  end if;
  update org_invites set expires_at = now() where id = target_invite_id and org_id = my_org and used_at is null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_org_members()
 RETURNS TABLE(user_id uuid, email text, role text, resolver_group_id uuid, resolver_group_name text, whatsapp_number text)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select m.user_id, u.email, m.role, m.resolver_group_id, rg.name, m.whatsapp_number
  from org_members m
  join auth.users u on u.id = m.user_id
  left join resolver_groups rg on rg.id = m.resolver_group_id
  where m.org_id = current_org_id();
$function$;

CREATE OR REPLACE FUNCTION public.set_member_resolver_group(target_user_id uuid, target_group_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  my_org uuid;
  my_role text;
begin
  select org_id, role into my_org, my_role from org_members where user_id = auth.uid();
  if my_role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can assign team membership.';
  end if;
  update org_members set resolver_group_id = target_group_id
  where user_id = target_user_id and org_id = my_org;
  insert into audit_log (org_id, actor_user_id, action, detail)
  values (my_org, auth.uid(), 'team_assignment_changed', 'Member reassigned to a different resolver group');
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_member_whatsapp_number(target_user_id uuid, number text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  my_org uuid;
  my_role text;
begin
  select org_id, role into my_org, my_role from org_members where user_id = auth.uid();
  if my_role not in ('owner', 'admin') and auth.uid() != target_user_id then
    raise exception 'You can only set your own WhatsApp number, unless you are an owner or admin.';
  end if;
  update org_members set whatsapp_number = number where user_id = target_user_id and org_id = my_org;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_identity_module(enabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.rotate_portal_slug()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

-- ---- public portal (unauthenticated customer intake) ----

CREATE OR REPLACE FUNCTION public.portal_categories(slug text)
 RETURNS TABLE(name text)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select c.name from categories c
  join organisations o on o.id = c.org_id
  where o.portal_slug = slug
  order by c.name;
$function$;

CREATE OR REPLACE FUNCTION public.submit_via_portal(slug text, incident_title text, incident_notes text, category_name text)
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

  insert into incidents (org_id, display_id, title, notes, category_id, severity_id, status_id, sla_minutes, source)
  select target_org_id, new_display_id, incident_title, incident_notes, matched_category_id, fallback_severity_id,
         fallback_status_id, sla_minutes, 'portal'
  from severities where id = fallback_severity_id
  returning id into new_incident_id;

  insert into incident_timeline (incident_id, org_id, status_id, note)
  values (new_incident_id, target_org_id, fallback_status_id, 'Submitted via self-service portal');

  insert into incident_customer_access (incident_id, org_id) values (new_incident_id, target_org_id)
  returning token into new_token;

  return query select new_display_id, new_token;
end;
$function$;

CREATE OR REPLACE FUNCTION public.search_kb_articles(slug text, search_query text)
 RETURNS TABLE(id uuid, title text, body text)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select a.id, a.title, a.body
  from kb_articles a
  join organisations o on o.id = a.org_id
  where o.portal_slug = slug
    and length(trim(search_query)) > 0
    and a.search_vector @@ plainto_tsquery('english', search_query)
  order by ts_rank(a.search_vector, plainto_tsquery('english', search_query)) desc
  limit 3;
$function$;

CREATE OR REPLACE FUNCTION public.log_kb_feedback(article_id uuid, was_helpful boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  update kb_articles set
    view_count = view_count + 1,
    helpful_count = helpful_count + (case when was_helpful then 1 else 0 end),
    not_helpful_count = not_helpful_count + (case when was_helpful then 0 else 1 end)
  where id = article_id;
$function$;

-- ---- one-click acknowledge (email links) ----

CREATE OR REPLACE FUNCTION public.get_or_create_ack_token(target_incident_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  existing_token text;
  new_token text;
  target_org uuid;
begin
  select token into existing_token from incident_ack_tokens
  where incident_id = target_incident_id and used_at is null limit 1;
  if existing_token is not null then
    return existing_token;
  end if;
  select org_id into target_org from incidents where id = target_incident_id;
  insert into incident_ack_tokens (incident_id, org_id) values (target_incident_id, target_org)
  returning token into new_token;
  return new_token;
end;
$function$;

CREATE OR REPLACE FUNCTION public.acknowledge_via_token(token_value text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  rec record;
begin
  select * into rec from incident_ack_tokens where token = token_value and used_at is null;
  if rec is null then
    raise exception 'This acknowledgment link is invalid or has already been used.';
  end if;
  update incidents set acknowledged_at = now() where id = rec.incident_id and acknowledged_at is null;
  update incident_ack_tokens set used_at = now() where token = token_value;
  insert into incident_timeline (incident_id, org_id, note)
  values (rec.incident_id, rec.org_id, 'Acknowledged via one-click link');
  return (select display_id from incidents where id = rec.incident_id);
end;
$function$;

-- ---- customer tracking page (/track/<token>) ----

CREATE OR REPLACE FUNCTION public.get_incident_status_for_customer(track_token text)
 RETURNS TABLE(display_id text, title text, status_name text, created_at timestamp with time zone, resolved_at timestamp with time zone, can_reopen boolean)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select i.display_id, i.title, st.name, i.created_at, i.resolved_at,
    (i.resolved_at is not null and i.resolved_at > now() - interval '14 days')
  from incidents i
  join incident_customer_access a on a.incident_id = i.id
  left join statuses st on st.id = i.status_id
  where a.token = track_token;
$function$;

CREATE OR REPLACE FUNCTION public.list_customer_visible_comments(track_token text)
 RETURNS TABLE(body text, author_type text, created_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select c.body, c.author_type, c.created_at
  from incident_comments c
  join incident_customer_access a on a.incident_id = c.incident_id
  where a.token = track_token and c.visibility = 'customer'
  order by c.created_at asc;
$function$;

CREATE OR REPLACE FUNCTION public.list_customer_attachments(track_token text)
 RETURNS TABLE(file_name text, storage_path text, created_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select a.file_name, a.storage_path, a.created_at
  from incident_attachments a
  join incident_customer_access c on c.incident_id = a.incident_id
  where c.token = track_token
  order by a.created_at asc;
$function$;

CREATE OR REPLACE FUNCTION public.add_customer_comment(track_token text, comment_body text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  rec record;
begin
  select * into rec from incident_customer_access where token = track_token;
  if rec is null then
    raise exception 'Invalid tracking link.';
  end if;
  insert into incident_comments (incident_id, org_id, author_type, visibility, body)
  values (rec.incident_id, rec.org_id, 'customer', 'customer', comment_body);
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_customer_attachment(track_token text, path text, fname text, fsize integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  rec record;
begin
  select * into rec from incident_customer_access where token = track_token;
  if rec is null then
    raise exception 'Invalid tracking link.';
  end if;
  insert into incident_attachments (org_id, incident_id, storage_path, file_name, file_size, uploaded_by_type)
  values (rec.org_id, rec.incident_id, path, redact_pii(fname), fsize, 'customer');
end;
$function$;

CREATE OR REPLACE FUNCTION public.reopen_incident_via_token(track_token text, reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  rec record;
  inc record;
  first_status_id uuid;
begin
  select * into rec from incident_customer_access where token = track_token;
  if rec is null then
    raise exception 'Invalid tracking link.';
  end if;

  select * into inc from incidents where id = rec.incident_id;
  if inc.resolved_at is null then
    raise exception 'This incident is not currently marked resolved.';
  end if;
  if inc.resolved_at < now() - interval '14 days' then
    raise exception 'This was resolved more than 14 days ago and can no longer be reopened here — please submit a new request mentioning %.', inc.display_id;
  end if;

  select id into first_status_id from statuses where org_id = inc.org_id order by sort_order limit 1;
  update incidents set resolved_at = null, status_id = first_status_id where id = inc.id;

  insert into incident_comments (incident_id, org_id, author_type, visibility, body)
  values (inc.id, inc.org_id, 'customer', 'customer', 'Reopened: ' || coalesce(nullif(redact_pii(reason), ''), 'No reason given'));

  insert into incident_timeline (incident_id, org_id, note)
  values (inc.id, inc.org_id, 'Reopened by customer');
end;
$function$;

-- ---- vendor-facing pages (/vendor/<token>, /quote/<token>) ----
-- NOTE: notify_vendor_on_link() below queries incident_vendor_access, a
-- table that does not exist in this schema — see header comment. It is not
-- wired to any trigger, so it is currently dead code rather than a live bug.

CREATE OR REPLACE FUNCTION public.notify_vendor_on_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
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
      'body', 'Hi ' || coalesce(v.contact_name, v.name) || E',\n\nAn issue has been logged that involves ' || v.name || E'. You can view it and reply here:\nhttps://signal-deck.derivcos.workers.dev/vendor/' || new_token,
      'from_name', sender_name
    )
  );

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_quote_request_for_vendor(track_token text)
 RETURNS TABLE(display_id text, description text, vendor_name text, quoted_price numeric, notes text, valid_until date, submitted_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select qr.display_id, qr.description, v.name, qrv.quoted_price, qrv.notes, qrv.valid_until, qrv.submitted_at
  from quote_request_vendors qrv
  join quote_requests qr on qr.id = qrv.quote_request_id
  join vendors v on v.id = qrv.vendor_id
  where qrv.token = track_token;
$function$;

CREATE OR REPLACE FUNCTION public.submit_quote_response(track_token text, price numeric, quote_notes text, expires date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  rec record;
begin
  select * into rec from quote_request_vendors where token = track_token;
  if rec is null then
    raise exception 'Invalid quote link.';
  end if;
  update quote_request_vendors
  set quoted_price = price, notes = redact_pii(quote_notes), valid_until = expires, submitted_at = now()
  where token = track_token;
end;
$function$;

-- ---- api_* integration RPCs (see API-DOCS.md) ----

CREATE OR REPLACE FUNCTION public.validate_api_key(raw_key text, required_scope text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.api_create_incident(api_key text, incident_title text, incident_notes text, category_name text, severity_name text DEFAULT 'Medium'::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.api_update_status(api_key text, incident_display_id text, new_status_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.api_list_incidents(api_key text, since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(display_id text, title text, category text, severity text, status text, source text, created_at timestamp with time zone, resolved_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.create_api_key(label text, scopes text[] DEFAULT ARRAY['create_incidents'::text])
 RETURNS TABLE(raw_key text, key_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.revoke_api_key(target_key_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

-- ---- approvals ----

CREATE OR REPLACE FUNCTION public.set_request_approval(target_incident_id uuid, decision text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  my_org uuid;
  my_role text;
  target_status_id uuid;
begin
  select org_id, role into my_org, my_role from org_members where user_id = auth.uid();
  if my_role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can approve or reject a request.';
  end if;
  if decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected.';
  end if;

  update incidents set approval_status = decision, approved_by = auth.uid(), approved_at = now()
  where id = target_incident_id and org_id = my_org;

  if decision = 'rejected' then
    select id into target_status_id from statuses where org_id = my_org and name ilike 'closed' limit 1;
    if target_status_id is null then
      select id into target_status_id from statuses where org_id = my_org order by sort_order desc limit 1;
    end if;
    update incidents set status_id = target_status_id, resolved_at = now()
    where id = target_incident_id and org_id = my_org;
  end if;

  insert into incident_timeline (incident_id, org_id, note)
  values (target_incident_id, my_org, 'Request ' || decision);
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_vendor_purchase_approval(target_purchase_id uuid, decision text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  my_org uuid;
  my_role text;
begin
  select org_id, role into my_org, my_role from org_members where user_id = auth.uid();
  if my_role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can approve or reject a vendor purchase.';
  end if;
  if decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected.';
  end if;

  update vendor_purchases set approval_status = decision, approved_by = auth.uid(), approved_at = now()
  where id = target_purchase_id and org_id = my_org;

  if decision = 'rejected' then
    update vendor_purchases set status = 'cancelled' where id = target_purchase_id;
  end if;
end;
$function$;

-- ---- ambient automation trust ledger ----

CREATE OR REPLACE FUNCTION public.ambient_flag_should_fire(target_org_id uuid, target_flag_type text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  with recent as (
    select action from ambient_flag_feedback
    where org_id = target_org_id and flag_type = target_flag_type
    order by created_at desc limit 5
  )
  select case
    when (select count(*) from recent) < 5 then true
    else (select bool_or(action = 'acted') from recent)
  end;
$function$;

CREATE OR REPLACE FUNCTION public.flag_automation_action_incorrect(event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  my_org uuid;
begin
  select org_id into my_org from org_members where user_id = auth.uid();
  update automation_events set outcome = 'fired_then_reverted'
  where id = event_id and org_id = my_org;
end;
$function$;

-- ---- escalation sweep (invoked on a schedule via pg_cron) ----

CREATE OR REPLACE FUNCTION public.run_escalation_check()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
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
      ack_link := 'https://signal-deck.derivcos.workers.dev/ack/' || ack_token;
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

-- ---- trigger functions ----

CREATE OR REPLACE FUNCTION public.map_ci_dependencies()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  dep record;
  this_ci_name text;
  dep_lines text := '';
  dep_count int := 0;
begin
  select name into this_ci_name from configuration_items where id = NEW.ci_id;

  for dep in
    select child.name as related_name, 'depends on' as direction
    from ci_relationships r join configuration_items child on child.id = r.child_ci_id
    where r.parent_ci_id = NEW.ci_id
    union all
    select parent.name as related_name, 'is depended on by' as direction
    from ci_relationships r join configuration_items parent on parent.id = r.parent_ci_id
    where r.child_ci_id = NEW.ci_id
  loop
    dep_lines := dep_lines || E'\n- ' || this_ci_name || ' ' || dep.direction || ' ' || dep.related_name;
    dep_count := dep_count + 1;
  end loop;

  if dep_count > 0 then
    insert into incident_comments (incident_id, org_id, author_type, visibility, body)
    values (
      NEW.incident_id, NEW.org_id, 'system', 'internal',
      'Dependency check for ' || this_ci_name || ' — the following related assets might also be affected, found by looking up existing CMDB relationships (no AI judgment involved):' || dep_lines
    );
  end if;

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_automation_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  rule record;
  event_name text;
  pg_net_present boolean;
  sender_name text;
  email_subject text;
  email_body text;
  target_webhook text;
  matches_group boolean;
begin
  select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = NEW.org_id;
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
    if rule.filter_resolver_group_id is not null then
      select exists(
        select 1 from incident_assignments
        where incident_id = NEW.id and resolver_group_id = rule.filter_resolver_group_id
      ) into matches_group;
      if not matches_group then
        continue;
      end if;
    end if;

    email_subject := NEW.display_id || ' — ' || event_name;
    email_body := 'Incident: ' || NEW.title || E'\nReference: ' || NEW.display_id || E'\nEvent: ' || event_name;

    if rule.action_type = 'email' and rule.action_email_to is not null then
      perform net.http_post(
        url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('to', rule.action_email_to, 'subject', email_subject, 'body', email_body, 'from_name', sender_name)
      );

    elsif rule.action_type in ('slack', 'teams') then
      target_webhook := null;
      if rule.filter_resolver_group_id is not null then
        select case when rule.action_type = 'slack' then channel_slack_webhook else channel_teams_webhook end
        into target_webhook
        from resolver_groups where id = rule.filter_resolver_group_id;
      end if;
      if target_webhook is null then
        select case when rule.action_type = 'slack' then slack_webhook else teams_webhook end
        into target_webhook
        from organisations where id = NEW.org_id;
      end if;
      if target_webhook is not null then
        perform net.http_post(
          url := target_webhook,
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object('text', email_subject || E'\n' || email_body)
        );
      end if;
    end if;

    update automation_rules set last_triggered_at = now() where id = rule.id;

    insert into automation_events (org_id, automation_type, automation_id, incident_id, outcome)
    values (NEW.org_id, 'automation_rule', rule.id, NEW.id, 'fired_no_objection');
  end loop;

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_webhooks()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.notify_customer_updates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
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
  message_body := event_label || E'.\n\nSee details or reply here: https://signal-deck.derivcos.workers.dev/track/' || coalesce(track_token, '');

  select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = incident_row.org_id;
  perform net.http_post(
    url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('to', identity_row.customer_contact, 'subject', event_label, 'body', message_body, 'from_name', sender_name)
  );

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_incident_participants()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  incident_row incidents%rowtype;
  pg_net_present boolean;
  sender_name text;
  event_label text;
  recipients text[];
  r text;
begin
  select exists(select 1 from pg_extension where extname = 'pg_net') into pg_net_present;
  if not pg_net_present then
    return coalesce(NEW, OLD);
  end if;

  if TG_TABLE_NAME = 'incident_comments' then
    if NEW.author_type <> 'staff' and NEW.visibility <> 'customer' then
      return NEW;
    end if;
    select * into incident_row from incidents where id = NEW.incident_id;
    event_label := 'New comment on ' || incident_row.display_id;
  else
    incident_row := NEW;
    if NEW.resolved_at is not null and OLD.resolved_at is null then
      event_label := incident_row.display_id || ' resolved';
    elsif NEW.status_id is distinct from OLD.status_id then
      event_label := incident_row.display_id || ' status updated';
    else
      return NEW;
    end if;
  end if;

  select array_agg(distinct u.email) into recipients
  from auth.users u
  join org_members m on m.user_id = u.id
  where m.org_id = incident_row.org_id
    and (
      m.resolver_group_id in (select resolver_group_id from incident_assignments where incident_id = incident_row.id)
      or m.user_id in (select author_user_id from incident_comments where incident_id = incident_row.id and author_user_id is not null)
    );

  if recipients is not null then
    foreach r in array recipients loop
      select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = incident_row.org_id;
      perform net.http_post(
        url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('to', r, 'subject', event_label, 'body', 'Incident: ' || incident_row.title || E'\nReference: ' || incident_row.display_id, 'from_name', sender_name)
      );
    end loop;
  end if;

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_staff_of_vendor_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  assignee_email text;
  incident_row incidents%rowtype;
  pg_net_present boolean;
  sender_name text;
begin
  if NEW.author_type <> 'vendor' then
    return NEW;
  end if;

  select exists(select 1 from pg_extension where extname = 'pg_net') into pg_net_present;
  if not pg_net_present then
    return NEW;
  end if;

  select * into incident_row from incidents where id = NEW.incident_id;

  select u.email into assignee_email
  from incident_assignments ia
  join auth.users u on u.id = ia.assigned_user_id
  where ia.incident_id = NEW.incident_id and ia.assigned_user_id is not null
  limit 1;

  if assignee_email is null then
    return NEW;
  end if;

  select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = NEW.org_id;

  perform net.http_post(
    url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'to', assignee_email,
      'subject', 'Vendor replied: ' || incident_row.display_id,
      'body', 'A vendor just replied on ' || incident_row.display_id || ' — ' || incident_row.title || E'.\n\nOpen it in Signal Deck to see the reply and respond.',
      'from_name', sender_name
    )
  );

  return NEW;
end;
$function$;

-- WARNING: references incident_vendor_access, which does not exist — see
-- header comment. This function is wired to a live AFTER trigger and will
-- error at runtime.
CREATE OR REPLACE FUNCTION public.notify_vendor_of_staff_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  access record;
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

  select * into incident_row from incidents where id = NEW.incident_id;
  select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = NEW.org_id;

  for access in select * from incident_vendor_access where incident_id = NEW.incident_id loop
    perform net.http_post(
      url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'to', (select contact_email from vendors where id = access.vendor_id),
        'subject', 'Update on ' || incident_row.display_id,
        'body', 'There is a new reply on the issue you are helping with.' || E'\n\nView and reply here:\nhttps://signal-deck.derivcos.workers.dev/vendor/' || access.token,
        'from_name', sender_name
      )
    );
  end loop;

  return NEW;
end;
$function$;

-- WARNING: references incident_vendor_access, which does not exist — see
-- header comment. This function is wired to a live AFTER trigger and will
-- error at runtime.
CREATE OR REPLACE FUNCTION public.notify_vendor_of_resolution()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  access record;
  pg_net_present boolean;
  sender_name text;
begin
  if NEW.resolved_at is null or OLD.resolved_at is not null then
    return NEW;
  end if;

  select exists(select 1 from pg_extension where extname = 'pg_net') into pg_net_present;
  if not pg_net_present then
    return NEW;
  end if;

  select coalesce(email_sender_name, name, 'Signal Deck') into sender_name from organisations where id = NEW.org_id;

  for access in select * from incident_vendor_access where incident_id = NEW.id loop
    perform net.http_post(
      url := 'https://soybukxnvtghebeuhsbg.supabase.co/functions/v1/send-email',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'to', (select contact_email from vendors where id = access.vendor_id),
        'subject', 'Resolved: ' || NEW.display_id,
        'body', NEW.display_id || ' — ' || NEW.title || ' has been marked resolved. Thank you for your help.' || E'\n\nhttps://signal-deck.derivcos.workers.dev/vendor/' || access.token,
        'from_name', sender_name
      )
    );
  end loop;

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_vendor_of_quote_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
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
      'body', 'Hi ' || coalesce(v.contact_name, v.name) || E',\n\nWe would like a quote for the following:\n' || qr.description || E'\n\nSubmit your price here — no account needed:\nhttps://signal-deck.derivcos.workers.dev/quote/' || NEW.token,
      'from_name', sender_name
    )
  );

  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_first_response_from_comment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if NEW.author_type = 'staff' then
    update incidents set first_response_at = now() where id = NEW.incident_id and first_response_at is null;
  end if;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_first_response_from_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if NEW.status_id is distinct from OLD.status_id and NEW.first_response_at is null then
    NEW.first_response_at := now();
  end if;
  return NEW;
end;
$function$;


-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE TRIGGER map_dependencies_on_ci_link AFTER INSERT ON public.incident_cis FOR EACH ROW EXECUTE FUNCTION map_ci_dependencies();

CREATE TRIGGER notify_customer_on_comment AFTER INSERT ON public.incident_comments FOR EACH ROW EXECUTE FUNCTION notify_customer_updates();
CREATE TRIGGER notify_participants_on_comment AFTER INSERT ON public.incident_comments FOR EACH ROW EXECUTE FUNCTION notify_incident_participants();
CREATE TRIGGER notify_staff_on_vendor_reply AFTER INSERT ON public.incident_comments FOR EACH ROW EXECUTE FUNCTION notify_staff_of_vendor_reply();
CREATE TRIGGER notify_vendor_on_staff_reply AFTER INSERT ON public.incident_comments FOR EACH ROW EXECUTE FUNCTION notify_vendor_of_staff_reply();
CREATE TRIGGER set_first_response_on_comment AFTER INSERT ON public.incident_comments FOR EACH ROW EXECUTE FUNCTION set_first_response_from_comment();

CREATE TRIGGER incidents_automation_trigger AFTER INSERT OR UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION notify_automation_rules();
CREATE TRIGGER incidents_webhook_trigger AFTER INSERT OR UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION notify_webhooks();
CREATE TRIGGER notify_customer_on_incident_update AFTER UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION notify_customer_updates();
CREATE TRIGGER notify_participants_on_incident_update AFTER UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION notify_incident_participants();
CREATE TRIGGER notify_vendor_on_resolution AFTER UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION notify_vendor_of_resolution();
CREATE TRIGGER set_first_response_on_status BEFORE UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION set_first_response_from_status();

CREATE TRIGGER notify_vendor_on_quote_request AFTER INSERT ON public.quote_request_vendors FOR EACH ROW EXECUTE FUNCTION notify_vendor_of_quote_request();


-- ============================================================================
-- ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- Every table below has RLS enabled (relforcerowsecurity is false on all of
-- them, i.e. not FORCE'd — table owners/superuser bypass RLS as usual).
-- ============================================================================

ALTER TABLE public.ambient_flag_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ci_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ci_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.configuration_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_dashboard_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escalation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identity_module_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_ack_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_cis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_custom_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_customer_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.on_call_rotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.preventative_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.problem_cis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.problem_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.problems ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_request_vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rca_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rca_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resolver_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.severities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sla_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

-- ---- policies ----

CREATE POLICY ambient_flag_feedback_org ON public.ambient_flag_feedback FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY api_keys_owner_admin ON public.api_keys FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));

CREATE POLICY org_isolation_all ON public.audit_log FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY automation_events_org ON public.automation_events FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY automation_rules_admin_write ON public.automation_rules FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY automation_rules_select ON public.automation_rules FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY business_templates_read ON public.business_templates FOR SELECT TO public USING (true);

CREATE POLICY categories_admin_write ON public.categories FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY categories_select ON public.categories FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY ci_relationships_org ON public.ci_relationships FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY ci_types_admin_write ON public.ci_types FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY ci_types_select ON public.ci_types FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY configuration_items_org ON public.configuration_items FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY custom_charts_org ON public.custom_charts FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY custom_dashboard_charts_org ON public.custom_dashboard_charts FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY custom_dashboards_org ON public.custom_dashboards FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY custom_fields_admin_write ON public.custom_fields FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY custom_fields_select ON public.custom_fields FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY escalation_policies_admin_write ON public.escalation_policies FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY escalation_policies_select ON public.escalation_policies FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY org_isolation_all ON public.escalations FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY org_isolation_insert ON public.identity_module_log FOR INSERT TO public WITH CHECK (org_id = current_org_id());
CREATE POLICY org_isolation_select ON public.identity_module_log FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY org_isolation_all ON public.incident_assignments FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY incident_attachments_org ON public.incident_attachments FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY incident_cis_org ON public.incident_cis FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY incident_comments_org ON public.incident_comments FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY incident_custom_values_org ON public.incident_custom_values FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY identity_gated_delete ON public.incident_identity FOR DELETE TO public USING (org_id = current_org_id());
CREATE POLICY identity_gated_insert ON public.incident_identity FOR INSERT TO public WITH CHECK (org_id = current_org_id() AND identity_module_is_on());
CREATE POLICY identity_gated_select ON public.incident_identity FOR SELECT TO public USING (org_id = current_org_id() AND identity_module_is_on());
CREATE POLICY identity_gated_update ON public.incident_identity FOR UPDATE TO public USING (org_id = current_org_id() AND identity_module_is_on());

CREATE POLICY org_isolation_all ON public.incident_timeline FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY incident_vendors_org ON public.incident_vendors FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY org_isolation_all ON public.incidents FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY webhooks_owner_admin ON public.integration_webhooks FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));

CREATE POLICY kb_articles_admin_write ON public.kb_articles FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY kb_articles_select ON public.kb_articles FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY on_call_rotations_admin_write ON public.on_call_rotations FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY on_call_rotations_select ON public.on_call_rotations FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY org_invites_org ON public.org_invites FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY member_self_select ON public.org_members FOR SELECT TO public USING (user_id = auth.uid());

CREATE POLICY org_self_select ON public.organisations FOR SELECT TO public USING (id = current_org_id());
CREATE POLICY org_self_update ON public.organisations FOR UPDATE TO public USING (id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));

CREATE POLICY preventative_actions_org ON public.preventative_actions FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY problem_cis_org ON public.problem_cis FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY problem_incidents_org ON public.problem_incidents FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY problems_org ON public.problems FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY quote_request_vendors_org ON public.quote_request_vendors FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY quote_requests_org ON public.quote_requests FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY rca_analyses_org ON public.rca_analyses FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY rca_categories_admin_write ON public.rca_categories FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY rca_categories_select ON public.rca_categories FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY resolver_groups_admin_write ON public.resolver_groups FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY resolver_groups_select ON public.resolver_groups FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY saved_views_org ON public.saved_views FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY service_catalog_items_admin_write ON public.service_catalog_items FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY service_catalog_items_select ON public.service_catalog_items FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY severities_admin_write ON public.severities FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY severities_select ON public.severities FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY sla_policies_admin_write ON public.sla_policies FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));
CREATE POLICY sla_policies_select ON public.sla_policies FOR SELECT TO public USING (org_id = current_org_id());

CREATE POLICY org_isolation_all ON public.statuses FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY vendor_purchases_org ON public.vendor_purchases FOR ALL TO public USING (org_id = current_org_id());

CREATE POLICY vendors_org ON public.vendors FOR ALL TO public USING (org_id = current_org_id());

-- Note: incident_ack_tokens and incident_customer_access have RLS enabled
-- but no policies were returned by pg_policies — with RLS on and zero
-- policies, all access to those two tables via the anon/authenticated roles
-- is denied by default; they are presumably only ever read/written through
-- the SECURITY DEFINER RPCs above (get_or_create_ack_token,
-- acknowledge_via_token, submit_via_portal, etc.), which bypass RLS.
