-- ============================================================================
-- FEATURE: real War Room for Critical incidents
-- ----------------------------------------------------------------------------
-- Replaces the old "War Room" button, which only fired one Slack/Teams
-- message and logged an `escalations` row with no real coordination surface
-- behind it. This adds a dedicated live view per incident: a shared
-- narrative, a comment thread, honest presence, a calm AI monitor, and a
-- hook into RCA on resolve. See the design discussion for full rationale;
-- key decisions confirmed before writing this:
--
-- 1. `on_call_rotations` already exists but is SHIFT-scheduled and scoped to
--    a resolver group (starts_at/ends_at, resolver_group_id) — not a simple
--    per-category opt-in. Reusing it would mean inventing fake shift times,
--    so `category_on_call_optins` below is a new, separate, simpler table:
--    a standing toggle, not a rotation.
--
-- 2. Nothing in this project uses Supabase Realtime yet (checked live —
--    the `supabase_realtime` publication exists but has zero tables in it).
--    This migration adds war_rooms / war_room_comments / war_room_presence
--    to it, scoped ONLY to this feature — the rest of the app keeps polling
--    as it already does. Confirmed with the founder before doing this.
--
-- 3. war_room_comments is a NEW table rather than reusing incident_comments.
--    incident_comments already drives customer/vendor-facing notification
--    triggers (notify_customer_updates, notify_vendor_of_staff_reply, etc.)
--    — bolting a "promoted to narrative" flag onto it risked tangling
--    internal war-room chatter into those triggers. Confirmed separately.
--
-- 4. The "calm AI monitor" (stale narrative / unassigned action item nudge)
--    runs CLIENT-SIDE, only while someone has the War Room view open — not
--    a pg_cron + pg_net call into the Groq edge function. That would mean a
--    service-role key sitting in a cron job, a materially riskier pattern,
--    for a feature that only matters while people are actually watching
--    anyway. Confirmed as the tradeoff.
--
-- Reviewed by migration-reviewer against the live schema before being handed
-- over: it caught a real bug (war_room_participants()'s ORDER BY referenced
-- an output alias inside an expression, which Postgres won't resolve — now
-- restructured as an outer query over a CTE) and a real gap (war_room_
-- presence's RLS only checked org_id, so any org member could have spoofed
-- or wiped a colleague's presence row via direct table access — now split
-- into an org-wide SELECT policy plus a self-scoped write policy). Both are
-- fixed below.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Auto-routing: category on-call opt-in
-- ----------------------------------------------------------------------------
CREATE TABLE public.category_on_call_optins (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  category_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_on_call_optins_pkey PRIMARY KEY (id),
  CONSTRAINT category_on_call_optins_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE,
  CONSTRAINT category_on_call_optins_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
  CONSTRAINT category_on_call_optins_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT category_on_call_optins_unique UNIQUE (category_id, user_id)
);
CREATE INDEX category_on_call_optins_org_id_idx ON public.category_on_call_optins USING btree (org_id);
CREATE INDEX category_on_call_optins_category_id_idx ON public.category_on_call_optins USING btree (category_id);

ALTER TABLE public.category_on_call_optins ENABLE ROW LEVEL SECURITY;
-- Anyone in the org can see who's opted in (needed to render "who's on call"
-- in Settings, and by war_room_participants() below).
CREATE POLICY category_on_call_optins_select ON public.category_on_call_optins
  FOR SELECT TO public USING (org_id = current_org_id());
-- Self-serve: you can opt yourself in or out. Admins/owners can manage
-- anyone's, same split already used for resolver_groups/rca_categories.
CREATE POLICY category_on_call_optins_self_write ON public.category_on_call_optins
  FOR INSERT TO public WITH CHECK (org_id = current_org_id() AND user_id = auth.uid());
CREATE POLICY category_on_call_optins_self_delete ON public.category_on_call_optins
  FOR DELETE TO public USING (org_id = current_org_id() AND user_id = auth.uid());
CREATE POLICY category_on_call_optins_admin_write ON public.category_on_call_optins
  FOR ALL TO public USING (org_id = current_org_id() AND current_org_role() = ANY (ARRAY['owner','admin']));

-- ----------------------------------------------------------------------------
-- 2. The war room itself: one row per incident, three narrative fields
-- ----------------------------------------------------------------------------
CREATE TABLE public.war_rooms (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  what_we_know text NOT NULL DEFAULT '',
  what_tried text NOT NULL DEFAULT '',
  whats_next text NOT NULL DEFAULT '',
  opened_by uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_narrative_update_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT war_rooms_pkey PRIMARY KEY (id),
  CONSTRAINT war_rooms_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE,
  CONSTRAINT war_rooms_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
  CONSTRAINT war_rooms_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES auth.users(id),
  CONSTRAINT war_rooms_incident_id_unique UNIQUE (incident_id)
);
CREATE INDEX war_rooms_org_id_idx ON public.war_rooms USING btree (org_id);

ALTER TABLE public.war_rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY war_rooms_org ON public.war_rooms FOR ALL TO public USING (org_id = current_org_id());

-- Auto-stamp last_narrative_update_at only when a narrative field actually
-- changes — not on every touch (e.g. closed_at) — so the AI monitor's
-- "stale narrative" check means what it says.
CREATE OR REPLACE FUNCTION public.touch_war_room_narrative()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if (NEW.what_we_know IS DISTINCT FROM OLD.what_we_know)
     or (NEW.what_tried IS DISTINCT FROM OLD.what_tried)
     or (NEW.whats_next IS DISTINCT FROM OLD.whats_next) then
    NEW.last_narrative_update_at := now();
  end if;
  return NEW;
end;
$function$;

CREATE TRIGGER touch_war_room_narrative BEFORE UPDATE ON public.war_rooms
  FOR EACH ROW EXECUTE FUNCTION public.touch_war_room_narrative();

-- Idempotent open: creates the row on first "Open War Room" click, just
-- returns the existing one on any click after that (e.g. a second
-- responder opening the same incident later).
CREATE OR REPLACE FUNCTION public.open_war_room(target_incident_id uuid)
 RETURNS public.war_rooms
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  row public.war_rooms;
begin
  insert into war_rooms (org_id, incident_id, opened_by)
  values (current_org_id(), target_incident_id, auth.uid())
  on conflict (incident_id) do nothing;

  select * into row from war_rooms where incident_id = target_incident_id;
  return row;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 3. Comment thread, separate from the narrative and from incident_comments
-- ----------------------------------------------------------------------------
CREATE TABLE public.war_room_comments (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  war_room_id uuid NOT NULL,
  author_user_id uuid,
  author_type text NOT NULL DEFAULT 'staff',
  body text NOT NULL,
  promoted_to_field text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT war_room_comments_pkey PRIMARY KEY (id),
  CONSTRAINT war_room_comments_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE,
  CONSTRAINT war_room_comments_war_room_id_fkey FOREIGN KEY (war_room_id) REFERENCES war_rooms(id) ON DELETE CASCADE,
  CONSTRAINT war_room_comments_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES auth.users(id),
  CONSTRAINT war_room_comments_author_type_check CHECK (author_type = ANY (ARRAY['staff','system'])),
  CONSTRAINT war_room_comments_promoted_to_field_check CHECK (promoted_to_field IS NULL OR promoted_to_field = ANY (ARRAY['what_we_know','what_tried','whats_next']))
);
CREATE INDEX war_room_comments_war_room_id_idx ON public.war_room_comments USING btree (war_room_id);
CREATE INDEX war_room_comments_org_id_idx ON public.war_room_comments USING btree (org_id);

ALTER TABLE public.war_room_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY war_room_comments_org ON public.war_room_comments FOR ALL TO public USING (org_id = current_org_id());

-- Promote a comment into the narrative and log which field it went to, in
-- one atomic step — avoids a client doing two separate writes that could
-- land out of order (e.g. losing the touch_war_room_narrative stamp).
CREATE OR REPLACE FUNCTION public.promote_war_room_comment(comment_id uuid, target_field text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  c public.war_room_comments;
begin
  if target_field not in ('what_we_know', 'what_tried', 'whats_next') then
    raise exception 'invalid target_field';
  end if;

  select * into c from war_room_comments where id = comment_id and org_id = current_org_id();
  if c.id is null then
    raise exception 'comment not found';
  end if;

  execute format('update war_rooms set %I = %I || case when %I = '''' then '''' else E''\n\n'' end || $1 where id = $2', target_field, target_field, target_field)
    using c.body, c.war_room_id;

  update war_room_comments set promoted_to_field = target_field where id = comment_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 4. Honest presence — heartbeat table, no cursors/avatars
-- ----------------------------------------------------------------------------
CREATE TABLE public.war_room_presence (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  war_room_id uuid NOT NULL,
  user_id uuid NOT NULL,
  last_viewed_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT war_room_presence_pkey PRIMARY KEY (id),
  CONSTRAINT war_room_presence_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE,
  CONSTRAINT war_room_presence_war_room_id_fkey FOREIGN KEY (war_room_id) REFERENCES war_rooms(id) ON DELETE CASCADE,
  CONSTRAINT war_room_presence_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT war_room_presence_unique UNIQUE (war_room_id, user_id)
);
CREATE INDEX war_room_presence_war_room_id_idx ON public.war_room_presence USING btree (war_room_id);

ALTER TABLE public.war_room_presence ENABLE ROW LEVEL SECURITY;
-- Anyone in the org can see presence (needed to render everyone else's
-- status), but a direct table write can only ever claim YOUR OWN user_id —
-- otherwise anyone could spoof a colleague's "viewing now" status or wipe
-- their presence via a plain UPDATE/DELETE. heartbeat_war_room_presence()
-- below still works fine despite this: it's SECURITY DEFINER and owned by
-- the table owner, so it isn't subject to RLS at all, same as every other
-- SECURITY DEFINER function in this schema (current_org_id() included).
CREATE POLICY war_room_presence_select ON public.war_room_presence
  FOR SELECT TO public USING (org_id = current_org_id());
CREATE POLICY war_room_presence_self_write ON public.war_room_presence
  FOR ALL TO public USING (org_id = current_org_id() AND user_id = auth.uid())
  WITH CHECK (org_id = current_org_id() AND user_id = auth.uid());

-- Heartbeat, called every ~20s by anyone with the view open. last_viewed_at
-- is set once and left alone; last_active_at refreshes every call — that
-- gap is what tells "viewing now" apart from "viewed, went quiet".
CREATE OR REPLACE FUNCTION public.heartbeat_war_room_presence(target_war_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  insert into war_room_presence (org_id, war_room_id, user_id, last_viewed_at, last_active_at)
  values (current_org_id(), target_war_room_id, auth.uid(), now(), now())
  on conflict (war_room_id, user_id) do update set last_active_at = now();
end;
$function$;

-- Computes the pulled-in list (assigned resolver group members UNION
-- category on-call opt-ins) joined against presence, with status derived
-- server-side so the frontend doesn't duplicate this logic. "never_viewed"
-- is the absence of a war_room_presence row, not a stored flag.
CREATE OR REPLACE FUNCTION public.war_room_participants(target_incident_id uuid)
 RETURNS TABLE(user_id uuid, email text, source text, last_viewed_at timestamptz, last_active_at timestamptz, status text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
AS $function$
  with pulled_in as (
    select m.user_id, 'assigned_group'::text as source
    from incident_assignments ia
    join org_members m on m.resolver_group_id = ia.resolver_group_id
    where ia.incident_id = target_incident_id and ia.resolver_group_id is not null
    union
    select o.user_id, 'on_call'::text as source
    from incidents i
    join category_on_call_optins o on o.category_id = i.category_id
    where i.id = target_incident_id
  ),
  wr as (
    select id from war_rooms where incident_id = target_incident_id
  ),
  computed as (
    select
      p.user_id,
      u.email,
      min(p.source) as source,
      wp.last_viewed_at,
      wp.last_active_at,
      case
        when wp.last_active_at is not null and wp.last_active_at > now() - interval '45 seconds' then 'viewing_now'
        when wp.last_viewed_at is not null then 'viewed_inactive'
        else 'never_viewed'
      end as status
    from pulled_in p
    join auth.users u on u.id = p.user_id
    left join wr on true
    left join war_room_presence wp on wp.war_room_id = wr.id and wp.user_id = p.user_id
    where p.user_id in (select user_id from org_members where org_id = current_org_id())
    group by p.user_id, u.email, wp.last_viewed_at, wp.last_active_at
  )
  -- status is a real output column of `computed` here, not a bare alias
  -- reused inside an expression one level up — that form (`order by
  -- status = 'x' desc`) doesn't resolve in Postgres and was caught by
  -- migration-reviewer before this was ever run.
  select * from computed order by (status = 'never_viewed') desc, email;
$function$;

-- ----------------------------------------------------------------------------
-- Enable Realtime for this feature only — nothing else in the project is
-- on the supabase_realtime publication today (checked live before writing
-- this). Confirmed with the founder as a scoped, feature-only exception.
-- ----------------------------------------------------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE public.war_rooms, public.war_room_comments, public.war_room_presence;
