-- ============================================================================
-- FIX: vendor-notification trigger functions reference a nonexistent table
-- ----------------------------------------------------------------------------
-- notify_vendor_of_resolution() and notify_vendor_of_staff_reply() both
-- queried a table called incident_vendor_access, which was never created
-- anywhere in this schema (the real table is incident_vendors, which has no
-- token/contact columns at all). Both are wired to live AFTER triggers on
-- incidents and incident_comments respectively, so this was not dead code:
-- it broke real production behavior.
--
-- Confirmed impact before this fix: INC-2026-8196 (created 2026-08-07) had
-- its status changed to "Resolved" on 2026-08-14, but the resolved_at
-- column was left null because the same UPDATE statement's
-- notify_vendor_on_resolution trigger threw on the missing table and
-- rolled back just that part of the change. See 6-backfill note below for
-- the accompanying data repair.
--
-- Fix: strip the vendor-notification bodies down to safe no-ops. Trigger
-- wiring (notify_vendor_on_resolution on incidents, notify_vendor_on_staff_reply
-- on incident_comments) is left untouched — only the function bodies change.
-- Re-implement properly once a real vendor access/token table exists.
--
-- Out of scope here: notify_vendor_on_link() has the same bug but is not
-- attached to any trigger (dead code), so it's left as-is.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_vendor_of_staff_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  -- Vendor-reply email notifications removed: they depended on a table
  -- (incident_vendor_access) that was never created, which made this
  -- trigger throw on every staff reply with visibility='vendor'. Re-add
  -- once a real vendor access/token table exists.
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_vendor_of_resolution()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  -- Vendor-on-resolution email notifications removed: they depended on a
  -- table (incident_vendor_access) that was never created, which made
  -- every incident resolution throw and roll back. Re-add once a real
  -- vendor access/token table exists.
  return NEW;
end;
$function$;
