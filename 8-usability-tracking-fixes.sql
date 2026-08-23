-- ============================================================================
-- FIX: two usability findings that need real backend tracking, not just UI
-- ----------------------------------------------------------------------------
-- From a usability review of the vendor RFQ flow and the KB self-service
-- deflection flow:
--
-- 1. Staff had no way to tell whether a vendor had even opened their quote
--    link, versus the vendor simply not having decided yet — both looked
--    identical ("no response"). Add opened_at, stamped the first time the
--    public /quote/<token> page is loaded.
--
-- 2. kb_articles.view_count was only ever incremented when a customer
--    clicked a feedback button (log_kb_feedback), which means the actual
--    success case for deflection — someone reads the suggested article and
--    simply doesn't submit an incident — was invisible. It looked like
--    under-used articles were "working," when the number just wasn't
--    counting silent reads at all. Split "shown" from "feedback given":
--    record_kb_shown() increments view_count alone, at render time;
--    log_kb_feedback() no longer double-counts view_count, only
--    helpful/not_helpful.
-- ============================================================================

ALTER TABLE public.quote_request_vendors
  ADD COLUMN IF NOT EXISTS opened_at timestamptz;

CREATE OR REPLACE FUNCTION public.mark_quote_viewed(track_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  update quote_request_vendors
  set opened_at = coalesce(opened_at, now())
  where token = track_token;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_kb_shown(article_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  update kb_articles set view_count = view_count + 1 where id = article_id;
$function$;

CREATE OR REPLACE FUNCTION public.log_kb_feedback(article_id uuid, was_helpful boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  update kb_articles set
    helpful_count = helpful_count + (case when was_helpful then 1 else 0 end),
    not_helpful_count = not_helpful_count + (case when was_helpful then 0 else 1 end)
  where id = article_id;
$function$;
