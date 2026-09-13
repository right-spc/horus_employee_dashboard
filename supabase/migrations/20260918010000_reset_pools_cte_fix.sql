-- Fix CTE scope bug in reset_pools_for_day: `targets` was referenced by the
-- final SELECT count(*) AFTER the WITH statement closed (CTEs are per-statement),
-- so every invocation errored with 42P01. Never hit in production because the
-- only non-demo org with an end date anchors on day 30, which the cron skips.
-- Fix: move the widget re-enable into the CTE chain and count inside it.
-- Rollover semantics unchanged (see 20260918000000_dynamic_billing.sql).

BEGIN;

CREATE OR REPLACE FUNCTION public.reset_pools_for_day(p_day integer)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'core', 'crm', 'messaging', 'kb', 'business', 'comms', 'billing', 'analytics', 'system', 'voice'
AS $function$
DECLARE
  affected integer;
BEGIN
  WITH targets AS (
    SELECT o.id
    FROM organizations o
    WHERE o.subscription_end_date IS NOT NULL
      AND extract(day FROM o.subscription_end_date AT TIME ZONE 'UTC')::int = p_day
      AND o.is_demo = false
    FOR UPDATE
  ),
  history_log AS (
    INSERT INTO credit_cycle_history (
      organization_id, unused_credits, credits_rolled_over, forfeited, message_limit
    )
    SELECT p.organization_id,
           greatest(p.monthly_limit - p.used_this_month, 0),
           CASE WHEN p.rollover_enabled THEN greatest(p.monthly_limit - p.used_this_month, 0) ELSE 0 END,
           (p.rollover_credits > 0) OR (NOT p.rollover_enabled AND p.monthly_limit - p.used_this_month > 0),
           p.monthly_limit
    FROM core.org_usage_pools p
    JOIN targets t ON t.id = p.organization_id
    RETURNING organization_id
  ),
  reset_pools AS (
    UPDATE core.org_usage_pools p
       SET used_this_month = 0,
           rollover_credits = CASE WHEN p.rollover_enabled
                                   THEN greatest(p.monthly_limit - p.used_this_month, 0)
                                   ELSE 0 END,
           limit_exceeded_at = null,
           updated_at = now()
    FROM targets t
    WHERE p.organization_id = t.id
    RETURNING p.organization_id
  ),
  reset_orgs AS (
    UPDATE organizations o
       SET messages_used_this_month = 0,
           limit_exceeded_at = null,
           limit_notified_at = null
    FROM targets t
    WHERE o.id = t.id
    RETURNING o.id
  ),
  reenable_widgets AS (
    UPDATE widget_configs w
       SET enabled = true,
           disable_reason = null,
           disable_message = null
      FROM targets t
     WHERE w.organization_id = t.id
       AND w.disable_reason = 'usage_limit'
    RETURNING w.organization_id
  )
  SELECT count(*) INTO affected FROM reset_pools;
  RETURN affected;
END;
$function$;

COMMIT;
