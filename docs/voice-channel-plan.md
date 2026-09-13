# Horus Desk — Voice & Telephony Channel Plan

> Status: **APPROVED — UI-first build** (UI shell before Phase 0 spike, owner decision 2026-09-11).
> This document is the single source of truth for the voice channel project. SMS design is owned by the owner and is referenced here only where it intersects with voice.

> **2026-09-11 revision** (supersedes older sections where they conflict):
> - **KB architecture**: `kb.kb_chunks` was DROPPED. The KB is now `kb.kb_versions` (sections JSONB) with whole-KB injection. "Same KB, zero duplication" now means: voice instructions = the same `buildSystemPrompt` output (version-based) + voice wrapper. `loadAllKbChunks` → version loader.
> - **Dashboard layout**: no "Phone" org tab. Voice lives in the **Channels tab as a third pill** (`Website Chat · Email · Voice`; SMS later). **Demo orgs get NO voice** — website chat only.
> - **Privacy model (hard rule)**: employees see **aggregate usage only** — calls answered, total minutes, average duration, credits burned. NO caller numbers, NO per-call rows, NO recordings, NO transcripts anywhere in the employee dashboard. Conversations land in the CUSTOMER's inbox (channel `voice`). Employee APIs must not expose `comms.calls` rows.
> - **Recording cut from v1** — employees can't access recordings anyway; no reason to generate/store them.
> - **Fallback routing (new)**: when voice is disabled, the credit pool is exhausted, or after-hours says so → per-org fallback: `forward` (ring straight through to a forwarding number, no AI) or `voicemail` (caller hears a spoken greeting + leaves a message). Voicemail greeting = **typed text spoken via TTS** in the account's chosen voice (no audio upload in v1).
> - **Bundled pricing**: clients are NOT charged per number ($1/mo) or per-minute line items — everything is inside the voice package. The provisioning UI shows NO prices.
> - **Credit pools live**: voice is an `core.org_services` row (`service='voice'`) burning the shared pool at `credit_cost` per minute (10/min placeholder — owner sets final rate). `is_pool_exceeded(org,'voice')` gates call answering.
> - **Provisioning UX**: mirrors the Softphone app's AddNumberModal (area-code search → debounced live results w/ capability badges → pick → confirm), simplified: US-only, one number per org, no pricing display. `conversations.channel` CHECK constraint still lacks `'voice'` — alter in the voice migration.

---

## 1. What we're building

A third customer-facing channel: **voice**. Each client org gets a real US phone number. When a customer calls, an AI receptionist (same brain as chat and email) answers, responds from the org's existing knowledge base, books appointments, sends follow-up texts, and escalates to humans via warm transfer or message-taking. Calls, transcripts, and recordings flow into the existing dashboard.

**Unifying principle:** one KB (`kb.kb_chunks`), one personality, one set of answers — chat, email, voice, and SMS are just different fronts on the same AI.

## 2. Decisions locked in (from brainstorm 2026-09-07)

| Decision | Choice | Rationale |
|---|---|---|
| Voice engine | **Telnyx Voice AI (managed assistants)** | $0.05/min all-in engine (STT + TTS + orchestration + barge-in). Self-built media-stream pipeline = rebuilding turn-taking/barge-in ourselves for worse economics ($0.12–0.42/min stitched vs ~$0.056) |
| LLM | **`moonshotai/Kimi-K2.6`, thinking disabled** | Telnyx's designated voice model; co-located GPUs = sub-second response; ~$0.004/min; same model as chat/email = consistent answers. Thinking tokens disabled (reasoning delay = dead air on calls). Model is one config field per assistant → per-org override (e.g. `anthropic/claude-haiku-4-5`, native on Telnyx) possible later with zero architecture change |
| Assistant topology | **One Telnyx AI Assistant per org** | Per-tenant prompt-caching economics (same static-prefix trick as chat), per-org voice/greeting, isolation. Assistant `instructions` = our generated system prompt |
| Call routing | **Call Control webhook path** (NOT direct number→assistant assignment in the Telnyx portal) | Keeps us in the loop before answering: billing, usage caps, after-hours mode, blocked callers, logging |
| Knowledge base | **Same versioned KB, zero duplication** | Voice instructions = same `buildSystemPrompt` output (from `kb.kb_versions` — chunks table dropped) + a voice-style wrapper (no markdown, one question at a time, speak numbers naturally, keep it short). Assistant re-synced via API on every KB/config save |
| Warm transfer | **Supported, per-org toggle** | Level 1: announced transfer w/ voicemail detection (human answers → bridged; voicemail/no answer → AI takes call back, message-taking). Level 2 (later): true 3-way warm handoff via Telnyx multi-participant calls (AI briefs human privately, then bridges). Default escalation = message-taking + notification (same as chat/email today) |
| AI sends texts mid-call | **Yes, via `send_text` webhook tool** | Booking confirmations, email addresses, links — sent from the SAME number the customer called. Gate: number must have SMS capability (+$0.10/mo) AND 10DLC/toll-free registration cleared, else carriers filter/fine |
| Pricing to clients | **Owner's domain — out of scope here** | This plan covers only Horus-side costs and technical build |

## 3. Horus-side costs (US)

| Item | Cost |
|---|---|
| Phone number per org | $1.00/mo (+$0.10/mo SMS capability) |
| Voice engine (STT + TTS + orchestration) | $0.05/min |
| Telephony (inbound local) | ~$0.0032/min |
| Kimi tokens (cache-heavy) | ~$0.004/min |
| Call recording (optional per org) | $0.002/min |
| Transferred call leg (after AI drops) | ~$0.005/min plain telephony (engine billing stops at transfer) |
| SMS sent (confirmations etc.) | ~$0.008/msg all-in |
| **Voice all-in** | **~$0.06/min (~$0.24 per typical 4-min call)** |

Fixed cost per idle org: **$1/mo**. A 200-call/mo client (~13 talk-hours) ≈ **$49/mo** total.
10DLC (needed for SMS): $4.50 brand one-time + $1.50–10/mo campaign, passed at cost by Telnyx, no markup. Toll-free verification is the alternative (skips 10DLC, 1–3 days, ~$0.015–0.02/msg).

## 4. End-to-end call flow

```
1. Customer dials org's number (comms.phone_numbers)
2. Telnyx Call Control → handle-inbound-call edge function
   - resolve org by destination number
   - checks: voice enabled? monthly minute cap? after-hours mode?
   - insert comms.calls row → answer → ai_assistant_start(org's assistant_id)
3. Telnyx engine runs the call: Deepgram STT → Kimi K2.6 (thinking off) → TTS
   - barge-in, turn-taking, filler words handled by the engine
4. Mid-call tools → voice-tools edge function (sync webhooks + Telnyx filler messages
   at 0ms/5s/15s so the caller never hears dead air):
   - check_availability / book_appointment → existing calendar logic
   - send_text → SMS from the same number (post-registration)
   - escalate → notification + optional warm transfer (built-in Transfer tool,
     voicemail detection on transfer)
5. Call ends → handle-call-events receives call.conversation.ended
   - full transcript → messaging.conversations (channel 'voice') + messages rows
   - recording URL, duration, outcome, cost → comms.calls
   - call.conversation_insights.generated → structured analysis for dashboard
6. Call appears in dashboard inbox with transcript + recording player
```

## 5. Phases

### Phase 0 — Spike (~1 day, ~$5, no prod changes)

Prove quality before building product surface:

1. `GET /v2/ai/models` with existing `TELNYX_API_KEY` — confirm `moonshotai/Kimi-K2.6` for assistants
2. Buy one $1 test number
3. Create assistant via API (`POST /ai/assistants`): Horus Desk org's real full KB in instructions + voice wrapper, greeting, Deepgram STT, TTS voice pick, `hangup` tool + stub `check_availability` webhook tool
4. Wire inbound (minimal Call Control app or portal assignment for spike only) → `ai_assistant_start`
5. **Call it from a real phone.** Test: KB accuracy, latency/dead air, tool call, escalation phrasing, warm transfer to owner's cell, hangup behavior, transcript webhook payload
6. If quality disappoints → flip model to `anthropic/claude-haiku-4-5`, call again, A/B compare
7. Measure real per-call cost from Telnyx usage records vs $0.06/min estimate

**Exit criteria:** owner approves call quality; tool round-trips inside filler thresholds; transcript webhook confirmed sufficient for inbox rendering; transfer edge cases (what caller hears during dial) validated live.

### Phase 1 — Core plumbing (multi-tenant inbound, ~2–4 days)

**1a. DB migration** (`supabase/migrations/`):
- `comms.phone_numbers` — id, organization_id, telnyx_number_id, phone_number (E.164), capabilities (sms/voice), status, monthly_cost_cents
- `comms.calls` — id, organization_id, conversation_id (nullable), telnyx_call_control_id (unique), direction, from/to, assistant_id, timestamps, duration_seconds, recording_url, engine_minutes, llm token counts, cost_usd, outcome (completed/transferred/message_taken/abandoned), hangup_reason
- `comms.voice_configs` — organization_id PK, enabled, telnyx_assistant_id, tts_voice, greeting_text, after_hours_mode ('answer'/'fallback'), transfer_enabled, transfer_number, **fallback_mode ('forward'/'voicemail'), fallback_number, voicemail_greeting**, max_monthly_minutes (legacy — superseded by the credit pool), instructions_version, synced_at. NO recording_enabled (recording cut from v1 — privacy rule)
- **`messaging.conversations.channel` CHECK: ALTER to add 'voice'** (currently missing — verified 2026-09-11)
- `core.org_services` row for voice per org (usage_pool 'credits', credit_cost 10/min placeholder) — the credit-pool migration (20260915000000) already built this machinery
- Verify `messaging.conversations.channel` has no CHECK constraint blocking 'voice' (alter if needed)
- Verify `crm.contact_aliases` accepts phone aliases (callers merge with email/chat contacts)
- Grants per schema-reorg pattern; `comms` already in PostgREST schema list ✓

**1b. Shared prompt extraction:**
- Extract `buildSystemPrompt` + the KB-version loader from widget-chat into `supabase/functions/_shared/horus-prompt.ts`; widget-chat + handle-inbound-email import it (pure refactor, redeploy both)
- Add `buildVoiceInstructions()`: same content + voice-style wrapper

**1c. Edge functions** (all `verify_jwt=false`, deploy `--no-verify-jwt`, Ed25519 webhook signature verification):
- `handle-inbound-call` — Call Control state machine (initiated → checks → answer → start assistant; hangup → finalize cost)
- `voice-tools` — assistant webhook tools: check_availability, book_appointment, send_text, escalate. Auth via per-org integration-secret header. <2s response target
- `handle-call-events` — conversation.ended / insights → transcript into conversations/messages (channel 'voice'), recording+cost into comms.calls, analytics events

**1d. Assistant sync:** `_shared/voice-assistant-sync.ts` — `syncOrgAssistant(orgId)` creates assistant or POSTs new version; triggered from dashboard-api on KB/persona/profile/hours/services/voice-config saves; retry w/ backoff; stale `synced_at` badge on persistent failure (voice keeps answering with last-good instructions)

**1e. Number provisioning (server side):** dashboard-api endpoints — search available numbers, purchase, attach to Call Control app, insert row, create+sync assistant; release flow

### Phase 2 — Employee dashboard UI (BUILT FIRST, shell + mock data)

Per owner 2026-09-11: the UI is built BEFORE the Phase 0 spike, as a working shell against mock/stub data, so the spike's real API responses only need wiring in. Follows the existing Channels-tab pill pattern (dashboard.js single-file, no framework).

**Channels tab → Voice pill** (hidden for demo orgs), top → bottom:

1. **Status strip** — voice enabled state · assistant sync status (`Synced ✓ / Syncing… / Stale`) · minutes this cycle (from the shared credit pool, link to Billing tab)
2. **Phone Number card**
   - No number: explainer + "Get a Phone Number" → provisioning modal (Softphone-style): area-code input → debounced live search (`dashboard-api search_available_numbers`, Telnyx `available_phone_numbers` filtered US local) → results with capability badges → select ONE → confirm step (NO prices — "included in the voice package") → `order_phone_number` → number row in `comms.phone_numbers`
   - Has number: formatted number + copy button, capability badges (Voice / SMS), "Release number" behind typed-confirm guard (`release_phone_number` → Telnyx `DELETE /phone_numbers/{id}`)
3. **AI Receptionist card**
   - Enabled toggle (master switch)
   - Voice picker: 4–6 curated TTS voices as selectable rows w/ ▶ preview clip, saved per org (`voice_configs.tts_voice`)
   - Greeting text textarea w/ live counter (`voice_configs.greeting_text`)
4. **Escalation & Fallback card**
   - Warm transfer: toggle + transfer-to number (`transfer_enabled`, `transfer_number`; no-answer → AI takes call back, message-taking)
   - Fallback when disabled / pool exhausted / after-hours: pill `Forward calls` (fallback_number input) vs `Voicemail` (voicemail_greeting textarea, spoken via TTS in the org's voice)
   - After-hours mode: `Answer anyway` / `Use fallback` (reads `business_hours` + timezone from KB → Business Details)
5. **Usage card (aggregate ONLY — privacy rule)**
   - This cycle: calls answered · total minutes · average duration · credits burned
   - Hard rule: no caller numbers, no per-call rows, no recordings, no transcripts. dashboard-api returns only `count/sum/avg` aggregates.

**Other touchpoints:** Overview tab gains a Voice line in the Services card (enabled state + minutes this cycle); Billing → Services & Burn Rates shows the `voice` row (burn rate per minute, owner-editable); new-org modal services picker enables the Voice checkbox (currently disabled "soon").

**Explicitly NOT in the employee dashboard:** call log, recordings player, transcripts, caller numbers, voicemail inbox (all customer-domain).

### Phase 3 — Outbound calls (DEFERRED, separate approval)

Appointment reminders/follow-ups via `POST /v2/texml/ai_calls/` + Telnyx scheduled events. TCPA consent gates this. Phases 1–2 leave no blockers.

## 6. Out of scope

- SMS channel design (owner has it settled; voice reuses its number + sending plumbing)
- Client self-serve portal for voice settings (employee-side control plane first; client-facing via customer-api is a later, separate decision)
- Client pricing/packaging (owner's domain)
- Self-built media-stream pipeline (rejected)
- International calling (US only)

## 7. Verification

- Spike: live phone call evidence, measured cost
- Phase 1: test org E2E (provision → call → KB answer → booking → send text → transfer → transcript+recording+cost in DB), 2 simultaneous calls, after-hours mode, cap enforcement, assistant re-sync after KB edit
- Post-launch watch: latency feel, Kimi voice quality across accents (Deepgram `keyterm` boost per org for business names), tool-call failure rate, actual vs estimated $/min

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Assistant instruction size limits | Spike uses real full KB (largest ~34K chars — small); confirm version API accepts it |
| Sync tool webhook latency mid-call | Filler messages (0/5/15s tiers); our calendar calls run 1–2s |
| `conversations.channel` CHECK constraint | Migration includes verify-and-alter |
| Recording consent (2-party-consent states) | Per-org recording toggle + greeting disclosure; default ON w/ disclosure — owner sets policy |
| Webhook spoofing | Ed25519 signature verification on all 3 webhook functions |
| No local Deno (syntax errors surface at deploy) | Deploy each function immediately, test via curl, keep functions small |
| Assistant drift (sync fails silently after org edit) | synced_at staleness badge + cron reconciliation sweep |
| Client doesn't pick up on transfer | Voicemail detection on transfer → AI takes call back → message-taking |

## 9. Effort & git discipline

- Spike ~1 day (~$5) · Phase 1 ~2–4 days · Phase 2 ~1–2 days → **~1 week total to production voice**
- Commits local per phase; **never push without explicit owner approval** (pushing main auto-deploys public/ to ctr.horusdesk.com via Vercel)
- Full approved plan also archived at `C:\Users\Moaaz\.kimi\plans\amadeus-cho-kyle-rayner-wolverine.md`
