# Billing model (owner decisions 2026-09-17/18)

No plan names, no preset prices, no tiers. Everything is per-org and dynamic.

## Per org
- **Activated services** — `core.org_services` toggles (webchat / email / voice), each with its own burn rate (`credit_cost`). Open to all staff until RBAC locks it.
- **Monthly price** — `core.organizations.monthly_price_cents`, free-form, set on the Billing tab.
- **Renewal term** — `subscription_plan` ('monthly' | 'yearly') + `free_months` (0–24). Yearly renewal grants **12 + free_months** months (deal term, can change each cycle). Per-role free-month caps come with RBAC.
- **Monthly credit allowance** — pool `monthly_limit`, independent per-org lever.

## Floors (live in `system.settings`, never in code)
| key | seeded value | meaning |
|---|---|---|
| `min_monthly_credits` | 1000 | allowance can't go below this |
| `price_per_1000_credits_cents` | 5900 | price floor = allowance × rate ($59/1,000) |

Below-floor saves (price or allowance) require `core.dashboard_users.can_override_price_floor`; owners pass implicitly. Enforced server-side in `dashboard-api` (`update_org_billing`, `update_pool`); the UI floor text is display-only.

## Credits
Three buckets on `core.org_usage_pools`, burned by `increment_pool_usage` in strict order:
1. **rollover_credits** — unused monthly credits from last cycle only; die at next reset
2. **monthly** — `monthly_limit - used_this_month`
3. **addon_credits** — purchased; never expire

All empty → `limit_exceeded_at` set → **account suspended** (channels refuse AI; addon purchase or cycle reset restores).

`reset_pools_for_day` (daily cron, anchored on `subscription_end_date` day-of-month): leftover monthly → rollover iff `rollover_enabled`; old rollover dies; `credit_cycle_history` logs real `credits_rolled_over` + `forfeited`.

## Dead (removed in the rebuild)
- `PAYMENT_PRESETS` ($199/$299/$3,588) and `selectPayment`
- Tier selects (Settings, create-org, demo modals); `subscription_tier` column still displayed in the sales report — drop in the §8 cleanup
- Hardcoded +14-month yearly math (now 12 + `free_months`)

## RBAC batch notes (future)
- Role **owner → admin** rename
- Lock service toggles + burn-rate edits behind permissions
- Per-role caps on `free_months`
- `rollover_eligible` flag in `extendSubscription` is vestigial (old rollover model) — remove

## Migrations
- `20260918000000_dynamic_billing.sql` — columns, settings, final channel CHECK, voice seeds, waterfall RPCs
- `20260918010000_reset_pools_cte_fix.sql` — fixed latent CTE-scope bug in `reset_pools_for_day` (every call errored 42P01; never hit in prod because the only anchored org sits on day 30, which the cron skips)
