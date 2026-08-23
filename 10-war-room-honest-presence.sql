-- ============================================================================
-- FIX: War Room presence could show "Nobody's been pulled in yet" while
-- someone was actively in the room, typing
-- ----------------------------------------------------------------------------
-- Found by a usability review of 9-war-room.sql: war_room_participants()
-- only ever listed the assigned resolver group's members and anyone opted
-- into on-call for the incident's category (the "pulled_in" CTE). Anyone
-- else who joined anyway — a manager who jumped in, a colleague who
-- noticed, or just anyone at all on a brand-new org with no resolver group
-- assigned yet and nobody opted into on-call — would still heartbeat into
-- war_room_presence just fine, but would never appear in the participants
-- list at all, because the join excluded them rather than de-prioritizing
-- them. That's not an edge case for a new customer's very first Critical
-- incident — it's plausibly their first real experience of this panel, and
-- it's a false negative on the exact claim ("honest presence") the feature
-- exists to make.
--
-- Fix: union in anyone who actually has a war_room_presence row for this
-- war room, tagged with source 'joined' if they weren't already in the
-- routed set. Whoever is genuinely in the room now always shows up.
-- ============================================================================

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
  present as (
    select wp.user_id, 'joined'::text as source
    from war_room_presence wp
    join wr on wp.war_room_id = wr.id
  ),
  everyone as (
    select * from pulled_in
    union
    select * from present
  ),
  computed as (
    select
      e.user_id,
      u.email,
      -- Explicit priority, not alphabetical min() — 'joined' sorts before
      -- 'on_call' alphabetically, which would silently overwrite the more
      -- meaningful "why they're here" reason for someone who is both
      -- on-call AND has actually shown up. Caught by migration-reviewer:
      -- the frontend now displays source (a "(joined)" tag), so this isn't
      -- just cosmetic — assigned_group and on_call should always win over
      -- the fallback "joined" label when both are true.
      case min(case e.source when 'assigned_group' then 1 when 'on_call' then 2 else 3 end)
        when 1 then 'assigned_group'
        when 2 then 'on_call'
        else 'joined'
      end as source,
      wp.last_viewed_at,
      wp.last_active_at,
      case
        when wp.last_active_at is not null and wp.last_active_at > now() - interval '45 seconds' then 'viewing_now'
        when wp.last_viewed_at is not null then 'viewed_inactive'
        else 'never_viewed'
      end as status
    from everyone e
    join auth.users u on u.id = e.user_id
    left join wr on true
    left join war_room_presence wp on wp.war_room_id = wr.id and wp.user_id = e.user_id
    where e.user_id in (select user_id from org_members where org_id = current_org_id())
    group by e.user_id, u.email, wp.last_viewed_at, wp.last_active_at
  )
  select * from computed order by (status = 'never_viewed') desc, email;
$function$;
