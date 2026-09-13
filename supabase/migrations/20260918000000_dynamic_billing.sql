-- Dynamic billing model + voice seeds (owner decisions 2026-09-17/18).
--
-- Model:
--   * No plan names / preset prices. Per org: activated services + one
--     free-form monthly price + monthly credit allowance.
--   * Floor guardrail (DB settings, never hardcoded):
--       min_monthly_credits        — allowance can't go below this
--       price_per_1000_credits_cents — price floor = allowance x rate
--     Below-floor saves require core.dashboard_users.can_override_price_floor
--     (enforced in dashboard-api, owners pass implicitly).
--   * Credits: monthly allowance + rollover bucket (monthly credits only,
--     carries exactly 1 cycle, per-org toggle) + addons (never expire).
--     Burn order: rollover -> monthly -> addon; all empty => suspended.
--   * Renewal term (monthly/yearly) + free_months live on the org; yearly
--     renewal grants 12 + free_months (per-role caps come with RBAC).
--
-- Also lands the pending voice seeds: final conversations.channel CHECK
-- ('webchat','email','voice' — verified only webchat/email rows exist),
-- voice org_services rows (10 credits/min, disabled) and voice.configs stubs
-- for all non-demo orgs.

BEGIN;

-- ── Organizations: price + free months ───────────────────────────────────────
ALTER TABLE core.organizations
  ADD COLUMN IF NOT EXISTS monthly_price_cents integer CHECK (monthly_price_cents >= 0),
  ADD COLUMN IF NOT EXISTS free_months integer NOT NULL DEFAULT 0 CHECK (free_months BETWEEN 0 AND 24);

-- ── Pools: rollover bucket ───────────────────────────────────────────────────
ALTER TABLE core.org_usage_pools
  ADD COLUMN IF NOT EXISTS rollover_credits integer NOT NULL DEFAULT 0 CHECK (rollover_credits >= 0),
  ADD COLUMN IF NOT EXISTS rollover_enabled boolean NOT NULL DEFAULT true;

-- ── RBAC: price-floor override permission (owner role passes implicitly) ─────
ALTER TABLE core.dashboard_users
  ADD COLUMN IF NOT EXISTS can_override_price_floor boolean NOT NULL DEFAULT false;

-- ── system.settings: floor values live in the DB, not code ───────────────────
CREATE TABLE IF NOT EXISTS system.settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE system.settings ENABLE ROW LEVEL SECURITY; -- service-role only, no policies
GRANT ALL ON system.settings TO service_role;

INSERT INTO system.settings (key, value) VALUES
  ('min_monthly_credits',           '1000'::jsonb),  -- allowance floor per account
  ('price_per_1000_credits_cents',  '5900'::jsonb)   -- $59 per 1,000 credits (matches addon pricing)
ON CONFLICT (key) DO NOTHING;

-- ── Final channel set: webchat / email / voice ───────────────────────────────
ALTER TABLE messaging.conversations DROP CONSTRAINT conversations_channel_check;
ALTER TABLE messaging.conversations ADD CONSTRAINT conversations_channel_check
  CHECK (channel = ANY (ARRAY['webchat', 'email', 'voice']));

-- ── Voice seeds (non-demo orgs; demos never get voice) ───────────────────────
INSERT INTO core.org_services (organization_id, service, enabled, usage_pool, credit_cost)
SELECT o.id, 'voice', false, 'credits', 10
FROM core.organizations o
WHERE o.is_demo = false
ON CONFLICT (organization_id, service) DO NOTHING;

INSERT INTO voice.configs (organization_id)
SELECT o.id FROM core.organizations o
WHERE o.is_demo = false
ON CONFLICT (organization_id) DO NOTHING;

-- ── RPC: is_pool_exceeded — all three buckets count ──────────────────────────
CREATE OR REPLACE FUNCTION public.is_pool_exceeded(p_org uuid, p_service text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'core', 'crm', 'messaging', 'kb', 'business', 'comms', 'billing', 'analytics', 'system', 'voice'
AS $function$
  select coalesce((
    select (p.monthly_limit - p.used_this_month) + p.rollover_credits + p.addon_credits <= 0
    from core.org_services s
    join core.org_usage_pools p
      on p.organization_id = s.organization_id
     and p.pool = s.usage_pool
    where s.organization_id = p_org
      and s.service = p_service
  ), false)
$function$;

-- ── RPC: increment_pool_usage — waterfall burn ───────────────────────────────
-- Burn order: rollover (1-cycle leftover) -> monthly -> addon (never expires).
-- Returns TRUE when the pool is exhausted after this burn (suspension signal).
-- Missing service/pool rows fail OPEN (unchanged contract).
CREATE OR REPLACE FUNCTION public.increment_pool_usage(p_org uuid, p_service text, p_amount integer DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'core', 'crm', 'messaging', 'kb', 'business', 'comms', 'billing', 'analytics', 'system', 'voice'
AS $function$
DECLARE
  v_pool     text;
  v_cost     integer;
  v_rollover integer;
  v_limit    integer;
  v_used     integer;
  v_addon    integer;
  v_left     integer;
  v_burn     integer;
  v_exceeded boolean;
BEGIN
  SELECT s.usage_pool, coalesce(p_amount, s.credit_cost)
    INTO v_pool, v_cost
  FROM core.org_services s
  WHERE s.organization_id = p_org
    AND s.service = p_service;

  IF NOT FOUND THEN
    RETURN false; -- fail open
  END IF;

  SELECT p.rollover_credits, p.monthly_limit, p.used_this_month, p.addon_credits
    INTO v_rollover, v_limit, v_used, v_addon
  FROM core.org_usage_pools p
  WHERE p.organization_id = p_org
    AND p.pool = v_pool
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false; -- fail open
  END IF;

  -- waterfall: rollover -> monthly -> addon
  v_left := v_cost;
  v_burn := least(v_rollover, v_left);                        v_rollover := v_rollover - v_burn; v_left := v_left - v_burn;
  v_burn := least(greatest(v_limit - v_used, 0), v_left);     v_used := v_used + v_burn;           v_left := v_left - v_burn;
  v_burn := least(v_addon, v_left);                           v_addon := v_addon - v_burn;         v_left := v_left - v_burn;

  v_exceeded := (v_limit - v_used) + v_rollover + v_addon <= 0;

  UPDATE core.org_usage_pools
     SET rollover_credits = v_rollover,
         used_this_month  = v_used,
         addon_credits    = v_addon,
         limit_exceeded_at = CASE WHEN v_exceeded THEN coalesce(limit_exceeded_at, now()) ELSE limit_exceeded_at END,
         updated_at = now()
   WHERE organization_id = p_org
     AND pool = v_pool;

  -- backward-compat display counter (1 call = 1 message exchange)
  UPDATE organizations
     SET messages_used_this_month = coalesce(messages_used_this_month, 0) + 1
   WHERE id = p_org;

  RETURN v_exceeded;
END;
$function$;

-- ── RPC: reset_pools_for_day — 1-cycle rollover ──────────────────────────────
-- At cycle reset: leftover monthly credits become the rollover bucket IF
-- rollover_enabled (old rollover dies — "one month only"); addon untouched;
-- history logs real credits_rolled_over; widgets re-enabled.
-- NOTE: data-modifying CTEs share one snapshot, so history_log reads
-- pre-reset values even though reset_pools runs in the same statement.
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
  )
  UPDATE widget_configs w
     SET enabled = true,
         disable_reason = null,
         disable_message = null
    FROM targets t
   WHERE w.organization_id = t.id
     AND w.disable_reason = 'usage_limit';

  SELECT count(*) INTO affected FROM targets;
  RETURN affected;
END;
$function$;

COMMIT;
