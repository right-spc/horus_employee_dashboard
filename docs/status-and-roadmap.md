# Horus Desk — Status & Roadmap

> Last updated: **2026-09-11** · Branch state: `redesign` = KB redo + tone field + **credit pools** (unreleased), `main` = `f73b1c2` (production)
> This is the single reference for what's shipped, what's pending, and how we work. Related docs: `voice-channel-plan.md` (approved, not started), `client-rbac-plan.md` (§5 = KB versioning model).

---

## 1. Shipped (live on `main` / production)

### Widget feature arc (all live)
- **Streaming (SSE)** end-to-end: playground (Bite A) + live widget (Bite B). `ResponseTextExtractor` incrementally decodes `response_text` from streaming tool-call JSON; 45s stall-timeout re-armed per chunk; `finalizeStream` runs all side effects (persistence, escalation flip + 10-min debounce, usage, analytics) **even on client disconnect**. Non-streaming clients still get buffered JSON.
- **Pre-chat form dead-button fix** — root cause was a `type="submit"` button with no `<form>` element; wrapped in a real form (Enter key works).
- **Chat window sizing** — `height: min(650px, calc(100vh - 120px))`, `min-height: 200px`.
- **Organization logo** — `core.organizations.logo_url`, public `org-assets` bucket, `upload_org_logo`/`remove_org_logo` actions (magic-byte sniffing, 5MB cap, canvas downscale to 256×256 PNG, `?v=` cache-bust). Widget header/avatars/gate + dashboard preview, with themed-robot fallback everywhere; 60s config poll live-updates logo changes.
- **Branded pre-chat gate + disclaimer consent** — `widget_configs.disclaimer_enabled/disclaimer_text`, `conversations.consent_accepted_at/consent_version` (djb2 hash, once per session — no re-consent on text change, owner's call). Markdown links rendered safely. Consent stamped on conversation upsert.
- **Double welcome fix** — welcome now comes only from the server `CONVERSATION_STARTED`.
- **End Chat fixes** — `endChatNow()` wipes storage/session/DOM/gate overlays; works even after survey shown.
- **No-logo themed robot** everywhere (header, avatars, gate, dashboard preview).

### Platform / infra
- **Test playground** verified: test_mode 200 + AI reply, zero usage burned; key-override fix.
- **Latency investigation closed** — TTFT 5–15s is Telnyx-side K2.6 hidden reasoning + queue; KB size irrelevant (matrix-tested, ~99% prompt-cache hits). `reasoning_effort:"none"` = empty response, `"minimal"` = 422. Accepted as-is.
- **Vercel preview suppression** — `vercel.json` disables builds on `redesign`; production deploys from `main` only.

---

## 2. On `redesign` only (NOT yet in production)

### KB tab redo — "AI Settings" sub-pills (mirrors customer dashboard)
- **Personality** — AI tone + System Prompt (Use Template) + Routing Rules (owner-only), moved from Settings.
- **Business Details** *(new UI)* — `business_profiles` editor (basic info, contact & address, email signature, booking & policies) + **Availability** editor: Custom / 24·7 / None mode pills, timezone (moved from Settings), per-day rows (open checkbox, times, note), "Copy Monday to Tue–Fri".
- **Knowledge Base** — existing versioned sections editor + version history (untouched).
- **Change Requests** — amend-request review, pending-count badge on pill.
- **Settings decluttered** — prompt/routing/tone/timezone removed; demo staff see pointer card.
- **New dashboard-api actions (deployed)**: `get_business_details`, `update_business_profile` (upsert; demo write-protection for non-owners; `business_name` NOT NULL → falls back to org name; `country` omits when cleared), `update_business_hours` (validated delete+replace).
- **AI tone = free text, 200 chars** (was fixed select) — input + live counter; server-side trim/cap/empty→null; interpolated raw into prompt (`"Your tone should be {ai_tone}…"`).

### Credit pools (services & billing overhaul)
- **New tables**: `core.org_usage_pools` (org, pool key, `monthly_limit`, `addon_credits` **never expire**, `used_this_month`, `limit_exceeded_at`) + `core.org_services` (org, service webchat/email/voice/sms, `enabled`, `usage_pool`, `credit_cost`). Seeded 1:1 for all 14 orgs (nobody held rollover/addon balances).
- **New RPCs** (replacing the un-repoed legacy ones): `is_pool_exceeded(org, service)`, `increment_pool_usage(org, service)` (monthly bucket burns first, overflow burns addon; keeps legacy `messages_used_this_month` +1 for compat), `reset_pools_for_day(day)` (same subscription-end-day anchor, cycle-history log, widget re-enable). Legacy columns/functions remain until deferred cleanup.
- **Burn model (owner decisions)**: monthly credits die at reset (no rollover machinery); addon credits never expire and burn only after monthly runs out; webchat+email cost 1/message; voice=10/min, SMS=3 when those ship.
- **Enforcement switched**: widget-chat + handle-inbound-email now call pool RPCs (verified live: pool 395→396 on a real widget message); `reset-usage-counters` cron uses `reset_pools_for_day` (phantom `cycle_anchor_day` dead code removed — the old RPC had been re-enabling widgets all along).
- **Payments tab → Billing tab**: Credit Pools card (usage bars, owner edit limit/addon), Services & Burn Rates card (toggle + burn-rate edit), **Add Credits card** (custom credit amount + price — replaces fixed $59/1,000 preset; threaded through PayPal capture + dashboard invoices via `credits_added`), existing payment options/history below.
- **dashboard-api**: `get_org` returns `pools` + `services`; new owner-only `update_pool` / `update_service`; `create_org` accepts a services picker (webchat/email, voice/sms "soon") and seeds pool+services; `create_demo` seeds both; `reset_usage` resets pools; customer-api invoice capture applies `credits_added` to the pool.
- **Overview bar** reads from the pool (+ addon balance shown); phantom `cycle_anchor_day` fallback removed.

### Schema facts learned this phase
- Business tables live in `business` schema; `core.business_*` are security-invoker bridge views (writes through them verified).
- `business_hours`: `UNIQUE(organization_id, day_of_week, open_time)`, `CHECK (is_open → times required)`; one slot per day (no split shifts — would need schema + prompt change).
- **HD org seeded test data**: tagline + Mon–Fri 09:00–17:00 hours, "H" placeholder logo, sample disclaimer text (remove whenever).

---

## 3. Remaining work

### 🔴 Voice channel (NEXT UP)
- See `voice-channel-plan.md` (approved; note: it references the DROPPED `kb.kb_chunks` and the old tab layout — needs a refresh pass before building). Voice usage will be a service row (`credit_cost` per minute) burning the shared pool — the plumbing is now in place. `messaging.conversations.channel` CHECK still lacks `'voice'` — alter in the voice migration.

### 🟡 Smaller gaps
- **Business staff editor** — `business_staff` has no UI; fits as a card in KB → Business Details.
- **MS Graph webhook** — `handle-inbound-email` answers validationToken but has no change-notification processing path (Outlook inbound not flowing).
- **Voice/SMS channel** — see `voice-channel-plan.md` (approved; note: it references the DROPPED `kb.kb_chunks` and the old tab layout — needs a refresh pass before building).

### ⚪ Deferred cleanup (owner decides at end)
- Legacy credit columns now write-mostly: `rollover_credits`, `monthly_credits_remaining`, org-level `addon_credits`, plus legacy RPCs `increment_message_usage` / `is_usage_exceeded` / `reset_monthly_usage_for_day` — drop after the pool model proves out. Also: `usage_reset_date` (stale), `subscription_tier`, `auto_send_enabled`/`auto_send_min_confidence` + dead auto-send block in handle-inbound-email.
- Test data on HD org (disclaimer sample, placeholder logo).

### 🚀 Release pending
- `main` fast-forward from `redesign` — owner triggers with "push to master".

---

## 4. How we work (standing rules)

- **One bite at a time**; brainstorm = no changes until "let's do it".
- **Commit + push to `redesign` after every change batch.** Release = explicit "push to master" → fast-forward `main`.
- Deploy functions: `npx supabase functions deploy <names> --project-ref oknqxlmyhmxbzqtnlraq` (load `.env` into process env first).
- Migrations via `scripts/run-migration.mjs` (node heredoc; Postgres array columns need `'{...}'` literals).
- Parse-checks: `node --check dashboard.js`; `npx esbuild <fn>/index.ts --format=esm --outfile=NUL`.
- Local serve: `npx serve . -l 47432` → dashboard `/`, widget preview `/public/widget-preview.html`.
- `.env` service-role key is STALE — fetch live keys via mgmt API `GET .../v1/projects/{ref}/api-keys`. Functions use `INTERNAL_FUNCTION_SECRET` with service-role fallback.
- Live test widget key: `hd_live_383b9b5679837196fa7a125c` (Horus Desk org `c92d3a6f-eb0d-4c5c-969e-a3076b16c4ed`).
- Browser caching: widget.js code changes need one page reload after deploy; widget config self-refreshes every 60s.
