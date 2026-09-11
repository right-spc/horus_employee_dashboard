# Horus Desk — Voice & Telephony Channel Plan

> Status: **APPROVED for planning — no work started**. Build begins when the owner says go (earliest: next week after 2026-09-07).
> This document is the single source of truth for the voice channel project. SMS design is owned by the owner and is referenced here only where it intersects with voice.

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
| Knowledge base | **Same `kb.kb_chunks`, zero duplication** | Voice instructions = same `buildSystemPrompt` output + a voice-style wrapper (no markdown, one question at a time, speak numbers naturally, keep it short). Assistant re-synced via API on every KB/config save |
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
- `comms.voice_configs` — organization_id PK, enabled, telnyx_assistant_id, tts_voice, greeting_text, after_hours_mode ('answer'/'message'), transfer_enabled, transfer_number, recording_enabled, max_monthly_minutes, instructions_version, synced_at
- Verify `messaging.conversations.channel` has no CHECK constraint blocking 'voice' (alter if needed)
- Verify `crm.contact_aliases` accepts phone aliases (callers merge with email/chat contacts)
- Grants per schema-reorg pattern; `comms` already in PostgREST schema list ✓

**1b. Shared prompt extraction:**
- Extract `buildSystemPrompt` + `loadAllKbChunks` from widget-chat into `supabase/functions/_shared/horus-prompt.ts`; widget-chat + handle-inbound-email import it (pure refactor, redeploy both)
- Add `buildVoiceInstructions()`: same content + voice-style wrapper

**1c. Edge functions** (all `verify_jwt=false`, deploy `--no-verify-jwt`, Ed25519 webhook signature verification):
- `handle-inbound-call` — Call Control state machine (initiated → checks → answer → start assistant; hangup → finalize cost)
- `voice-tools` — assistant webhook tools: check_availability, book_appointment, send_text, escalate. Auth via per-org integration-secret header. <2s response target
- `handle-call-events` — conversation.ended / insights → transcript into conversations/messages (channel 'voice'), recording+cost into comms.calls, analytics events

**1d. Assistant sync:** `_shared/voice-assistant-sync.ts` — `syncOrgAssistant(orgId)` creates assistant or POSTs new version; triggered from dashboard-api on KB/persona/profile/hours/services/voice-config saves; retry w/ backoff; stale `synced_at` badge on persistent failure (voice keeps answering with last-good instructions)

**1e. Number provisioning (server side):** dashboard-api endpoints — search available numbers, purchase, attach to Call Control app, insert row, create+sync assistant; release flow

### Phase 2 — Employee dashboard UI (~1–2 days, this repo)

Fits existing structure (top nav: Organizations/Demos/Sales/Team; org tabs: Overview, Email Setup, Widget, KB, Integrations, Payments, Reports, Settings). No new top-level views.

1. **New org tab "Phone"**:
   - Number: current number, search-by-area-code → buy flow, release w/ guard
   - Voice: enable toggle, voice picker (4–6 curated voices w/ ▶ preview), greeting text, after-hours mode, warm transfer (toggle + number), recording toggle, monthly minute cap, assistant sync status indicator
   - SMS: capability + 10DLC/toll-free registration status (unregistered → pending → approved) + registration wizard
   - "Test it" call-now prompt
2. **Overview tab**: channel status pills (Chat/Email/Voice/SMS) + monthly voice minutes & SMS counts
3. **Reports tab**: calls, voice minutes, per-channel cost, SMS volume (from comms.calls + analytics)
4. **Call log** (in Reports or own tab): comms.calls table → detail with transcript (chat-style) + recording audio player
5. **Demos view**: demo orgs get voice too — sales pitch becomes "call this number and talk to the AI right now"
6. Follow existing dashboard.js single-file patterns, no framework

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
