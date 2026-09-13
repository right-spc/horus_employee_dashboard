-- Hygiene cleanup 2026-09-11: drop the legacy credit machinery fully replaced
-- by the credit-pool model (migration 20260915000000_credit_pools.sql).
--
-- Verified dead before dropping:
--   - increment_message_usage / is_usage_exceeded / reset_monthly_usage_for_day:
--     zero remaining callers (widget-chat, handle-inbound-email and
--     reset-usage-counters all use the pool RPCs; definitions were never in
--     the repo, so this is the authoritative removal)
--   - rollover_credits / monthly_credits_remaining / addon_credits on
--     core.organizations: no reads anywhere; all 14 orgs hold 0 in
--     rollover/addon; writes removed from create_org/create_demo
--   - usage_reset_date: set on all orgs but read by zero code (stale since
--     the billing_day_of_month model)
--
-- Kept on purpose: messages_used_this_month (display counter, maintained by
-- increment_pool_usage), message_limit_per_month (create-org seed input),
-- subscription_tier (visible in UI/sales report), billing.credit_cycle_history
-- (audit trail written by reset_pools_for_day).

drop function if exists public.increment_message_usage(uuid);
drop function if exists public.is_usage_exceeded(uuid);
drop function if exists public.reset_monthly_usage_for_day(integer);

alter table core.organizations
  drop column if exists rollover_credits,
  drop column if exists monthly_credits_remaining,
  drop column if exists addon_credits,
  drop column if exists usage_reset_date;

-- The every-minute cron named "test" is actually the delivery-queue pump —
-- renamed to process-delivery-queue. pg_cron on this project predates the
-- jobname option of cron.alter_job, so the rename was done operationally:
--   select cron.unschedule('test');
--   select cron.schedule('process-delivery-queue', '* * * * *', <same net.http_post command>);
-- (Recorded here for documentation; no-op if the old job is absent.)
select cron.unschedule('test') where exists (select 1 from cron.job where jobname = 'test');
