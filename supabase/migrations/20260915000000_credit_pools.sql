-- Credit pools: per-org usage pools + per-service registry.
-- Replaces the org-wide credit columns (rollover/monthly/addon on
-- core.organizations) with one shared 'credits' pool per org. Services point
-- at a pool and burn it at their own credit_cost.
--
-- Model (owner decisions 2026-09-11):
--   monthly_limit  — recurring credits; unused die at the monthly reset
--   addon_credits  — purchased/added credits; NEVER expire; burned only after
--                    the monthly bucket is exhausted
--   rollovers      — deprecated; no org held rollover/addon balances at
--                    migration time (verified), so seeding is 1:1
--
-- Old columns + RPCs (increment_message_usage, is_usage_exceeded,
-- reset_monthly_usage_for_day) stay in place until the deferred cleanup;
-- messages_used_this_month is still maintained for backward-compat reads.

-- ── Tables ────────────────────────────────────────────────────────────────────

create table if not exists core.org_usage_pools (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  pool text not null default 'credits',
  monthly_limit integer not null default 0 check (monthly_limit >= 0),
  addon_credits integer not null default 0 check (addon_credits >= 0),
  used_this_month integer not null default 0 check (used_this_month >= 0),
  limit_exceeded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, pool)
);

create table if not exists core.org_services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  service text not null check (service in ('webchat', 'email', 'voice', 'sms')),
  enabled boolean not null default true,
  usage_pool text not null default 'credits',
  credit_cost integer not null default 1 check (credit_cost > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, service)
);

alter table core.org_usage_pools enable row level security;
alter table core.org_services enable row level security;
-- No RLS policies: all access is via service-role edge functions (RLS bypass).

-- ── Seed (1:1 from current counters) ─────────────────────────────────────────

insert into core.org_usage_pools (organization_id, pool, monthly_limit, addon_credits, used_this_month, limit_exceeded_at)
select id,
       'credits',
       coalesce(message_limit_per_month, 0),
       coalesce(addon_credits, 0),
       coalesce(messages_used_this_month, 0),
       limit_exceeded_at
from core.organizations
on conflict (organization_id, pool) do nothing;

insert into core.org_services (organization_id, service, enabled, usage_pool, credit_cost)
select o.id, s.service, true, 'credits', 1
from core.organizations o
cross join (values ('webchat'), ('email')) as s(service)
on conflict (organization_id, service) do nothing;

-- ── RPCs ──────────────────────────────────────────────────────────────────────
-- Created in public with the full search_path, matching the existing pattern.

-- Is the pool backing this service exhausted? (monthly remainder + addon <= 0)
-- Missing service/pool rows fail OPEN (same as the legacy is_usage_exceeded).
create or replace function public.is_pool_exceeded(p_org uuid, p_service text)
returns boolean
language sql
stable
set search_path to 'public', 'core', 'crm', 'messaging', 'kb', 'business', 'comms', 'billing', 'analytics', 'system'
as $function$
  select coalesce((
    select (p.monthly_limit - p.used_this_month) + p.addon_credits <= 0
    from core.org_services s
    join core.org_usage_pools p
      on p.organization_id = s.organization_id
     and p.pool = s.usage_pool
    where s.organization_id = p_org
      and s.service = p_service
  ), false)
$function$;

-- Burn credits for a service (default: its credit_cost). Monthly bucket burns
-- first; overflow burns addon_credits (never expire). Also keeps the legacy
-- organizations.messages_used_this_month counter (+1 per call) for compat.
-- Returns TRUE when this call exhausted the pool.
create or replace function public.increment_pool_usage(p_org uuid, p_service text, p_amount integer default null)
returns boolean
language plpgsql
set search_path to 'public', 'core', 'crm', 'messaging', 'kb', 'business', 'comms', 'billing', 'analytics', 'system'
as $function$
declare
  v_pool  text;
  v_cost  integer;
  v_limit integer;
  v_used  integer;
  v_addon integer;
  v_exceeded boolean;
begin
  select s.usage_pool, coalesce(p_amount, s.credit_cost)
    into v_pool, v_cost
  from core.org_services s
  where s.organization_id = p_org
    and s.service = p_service;

  if not found then
    return false; -- fail open
  end if;

  update core.org_usage_pools p
     set used_this_month = case
           when p.monthly_limit - p.used_this_month >= v_cost
             then p.used_this_month + v_cost
           else p.monthly_limit end,
         addon_credits = case
           when p.monthly_limit - p.used_this_month >= v_cost
             then p.addon_credits
           else greatest(p.addon_credits - (v_cost - greatest(p.monthly_limit - p.used_this_month, 0)), 0) end,
         updated_at = now()
   where p.organization_id = p_org
     and p.pool = v_pool
  returning monthly_limit, used_this_month, addon_credits
     into v_limit, v_used, v_addon;

  if not found then
    return false; -- fail open
  end if;

  v_exceeded := (v_limit - v_used) + v_addon <= 0;

  if v_exceeded then
    update core.org_usage_pools
       set limit_exceeded_at = coalesce(limit_exceeded_at, now())
     where organization_id = p_org
       and pool = v_pool;
  end if;

  -- backward-compat display counter (1 call = 1 message exchange)
  update organizations
     set messages_used_this_month = coalesce(messages_used_this_month, 0) + 1
   where id = p_org;

  return v_exceeded;
end;
$function$;

-- Monthly reset for orgs whose subscription cycle ends on day p_day (UTC) —
-- same anchor semantics as the legacy reset_monthly_usage_for_day.
-- Resets pool counters (addon untouched — never expires), logs cycle history,
-- clears legacy org limit flags, re-enables usage-limit-disabled widgets.
create or replace function public.reset_pools_for_day(p_day integer)
returns integer
language plpgsql
set search_path to 'public', 'core', 'crm', 'messaging', 'kb', 'business', 'comms', 'billing', 'analytics', 'system'
as $function$
declare
  affected integer;
begin
  with targets as (
    select o.id
    from organizations o
    where o.subscription_end_date is not null
      and extract(day from o.subscription_end_date at time zone 'UTC')::int = p_day
      and o.is_demo = false
    for update
  ),
  history_log as (
    insert into credit_cycle_history (
      organization_id, unused_credits, credits_rolled_over, forfeited, message_limit
    )
    select p.organization_id,
           greatest(p.monthly_limit - p.used_this_month, 0),
           0,
           p.monthly_limit - p.used_this_month > 0,
           p.monthly_limit
    from core.org_usage_pools p
    join targets t on t.id = p.organization_id
    returning organization_id
  ),
  reset_pools as (
    update core.org_usage_pools p
       set used_this_month = 0,
           limit_exceeded_at = null,
           updated_at = now()
    from targets t
    where p.organization_id = t.id
    returning p.organization_id
  ),
  reset_orgs as (
    update organizations o
       set messages_used_this_month = 0,
           limit_exceeded_at = null,
           limit_notified_at = null
    from targets t
    where o.id = t.id
    returning o.id
  )
  update widget_configs w
     set enabled = true,
         disable_reason = null,
         disable_message = null
    from targets t
   where w.organization_id = t.id
     and w.disable_reason = 'usage_limit';

  select count(*) into affected from targets;
  return affected;
end;
$function$;
