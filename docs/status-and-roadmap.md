# Horus Desk — Status & Roadmap

> Last updated: **2026-09-11** · Branch state: `redesign` = `0ecfb2a` (KB redo + tone field), `main` = `f73b1c2` (production, KB redo NOT yet released)
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

### Schema facts learned this phase
- Business tables live in `business` schema; `core.business_*` are security-invoker bridge views (writes through them verified).
- `business_hours`: `UNIQUE(organization_id, day_of_week, open_time)`, `CHECK (is_open → times required)`; one slot per day (no split shifts — would need schema + prompt change).
- **HD org seeded test data**: tagline + Mon–Fri 09:00–17:00 hours, "H" placeholder logo, sample disclaimer text (remove whenever).

---

## 3. Remaining work

### 🔴 Services/credits overhaul (big Phase 3 piece)
- New `core.org_services` + `core.org_usage_pools` — credit-denominated, per-service burn rates (webchat 1 / email 10 / voice 3), per-pool limits; new-org modal services picker; per-pool limit editing.
- **Riding along — LIVE BUG:** `reset-usage-counters` cron queries non-existent `core.organizations.cycle_anchor_day` → usage-limit-paused widgets likely never auto re-enable.

### 🟡 Smaller gaps
- **Business staff editor** — `business_staff` has no UI; fits as a card in KB → Business Details.
- **MS Graph webhook** — `handle-inbound-email` answers validationToken but has no change-notification processing path (Outlook inbound not flowing).
- **Voice/SMS channel** — see `voice-channel-plan.md` (approved; note: it references the DROPPED `kb.kb_chunks` and the old tab layout — needs a refresh pass before building).

### ⚪ Deferred cleanup (owner decides at end)
- `usage_reset_date` column, rollover credits logic, `subscription_tier`, `auto_send_enabled`/`auto_send_min_confidence` + dead auto-send block in handle-inbound-email.
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
