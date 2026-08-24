-- ============================================================================
-- FEATURE: "received, not just sent" escalation receipts
-- ----------------------------------------------------------------------------
-- Every escalation channel today proves delivery, never that a human
-- actually saw it — a 200 from a Slack webhook proves the message left
-- Signal Deck, not that the on-call person's Slack was even open. This
-- reuses the exact one-tap acknowledge pattern already built for AckPage
-- (incident_ack_tokens / acknowledge_via_token) for a different purpose:
-- a per-escalation token, so the escalation log can show "sent →
-- acknowledged 4m ago" instead of just "sent (simulated)" or a bare
-- "sent to team channel" with no way to tell if anyone's actually looked.
--
-- Deliberately mirrors incident_ack_tokens exactly rather than inventing a
-- new pattern: RLS enabled with zero policies (deny-all for anon/
-- authenticated), all access via SECURITY DEFINER RPCs only — same
-- reasoning documented for incident_ack_tokens (schema-snapshot line
-- 2745-2750).
--
-- acknowledged_at lives directly on escalations (same split as incidents.
-- acknowledged_at living on incidents itself, separate from the token
-- bookkeeping table) — this is a distinct, narrower signal than the
-- incident's own acknowledged_at: "did someone confirm THIS specific page,"
-- not "has anyone picked up the incident at all." An incident can be
-- escalated and acknowledged multiple times across its life; each
-- escalation gets its own independent receipt.
-- ============================================================================

ALTER TABLE public.escalations ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;

CREATE TABLE public.escalation_ack_tokens (
  token text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'::text),
  escalation_id uuid NOT NULL,
  org_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  CONSTRAINT escalation_ack_tokens_pkey PRIMARY KEY (token),
  CONSTRAINT escalation_ack_tokens_escalation_id_fkey FOREIGN KEY (escalation_id) REFERENCES escalations(id) ON DELETE CASCADE,
  CONSTRAINT escalation_ack_tokens_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE
);
CREATE INDEX escalation_ack_tokens_escalation_id_idx ON public.escalation_ack_tokens USING btree (escalation_id);

ALTER TABLE public.escalation_ack_tokens ENABLE ROW LEVEL SECURITY;
-- No policies, by design — same as incident_ack_tokens. All reads/writes
-- go through create_escalation_ack_token()/acknowledge_escalation_via_token()
-- below, which bypass RLS as SECURITY DEFINER.

-- Called right after an escalation row is inserted, before the outbound
-- webhook fetch fires, so the token can be embedded in the message itself.
-- Get-or-create, same as get_or_create_ack_token — caught in review: an
-- unconditional insert here would mean any future retry/resend path
-- calling this twice for the same escalation accumulates multiple
-- simultaneously-valid links instead of reusing one.
CREATE OR REPLACE FUNCTION public.create_escalation_ack_token(target_escalation_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  existing_token text;
  new_token text;
  target_org uuid;
begin
  select token into existing_token from escalation_ack_tokens
  where escalation_id = target_escalation_id and used_at is null limit 1;
  if existing_token is not null then
    return existing_token;
  end if;
  select org_id into target_org from escalations where id = target_escalation_id;
  insert into escalation_ack_tokens (escalation_id, org_id) values (target_escalation_id, target_org)
  returning token into new_token;
  return new_token;
end;
$function$;

-- Mirrors acknowledge_via_token exactly: one-time-use token, sets the
-- timestamp only if not already set, logs to the incident's own timeline
-- so this shows up in the normal activity history too, not just the
-- escalation log.
CREATE OR REPLACE FUNCTION public.acknowledge_escalation_via_token(token_value text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  rec record;
  esc record;
begin
  select * into rec from escalation_ack_tokens where token = token_value and used_at is null;
  if rec is null then
    raise exception 'This link is invalid or has already been used.';
  end if;

  update escalations set acknowledged_at = coalesce(acknowledged_at, now())
  where id = rec.escalation_id
  returning * into esc;

  update escalation_ack_tokens set used_at = now() where token = token_value;

  insert into incident_timeline (incident_id, org_id, note)
  values (esc.incident_id, rec.org_id, format('%s escalation acknowledged via one-click link', esc.channel));

  return jsonb_build_object(
    'display_id', (select display_id from incidents where id = esc.incident_id),
    'channel', esc.channel
  );
end;
$function$;
