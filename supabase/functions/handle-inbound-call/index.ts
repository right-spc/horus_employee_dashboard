// ============================================
// EDGE FUNCTION: handle-inbound-call
// Telnyx Call Control webhook — the front door for EVERY client call.
// One shared Call Control app for all orgs (see dashboard-api
// ensureVoiceRouting); routes by dialed number:
//   voice.phone_numbers → org → checks (enabled / assistant synced /
//   pool not exhausted / after-hours mode) → answer → ai_assistant_start
// Fallback paths (voice off / pool exhausted / after hours):
//   forward   → answer + blind transfer to fallback_number
//   voicemail → answer + speak greeting (org's voice) + record the message
// Post-call (same webhook — assistant events arrive at the call's URL):
//   call.conversation.ended → transcript → messaging (channel 'voice',
//     contact resolved by phone alias) + recording URL + link on voice.calls
//   call.hangup → duration, outcome, cost estimate, credits burn (whole
//     minutes × org voice rate via increment_pool_usage)
//   call.conversation_insights.generated → conversation summary (best effort)
// Auth: Telnyx Ed25519 webhook signature (telnyx-signature-ed25519 header,
// message = "{timestamp}|{raw_body}", 5-min replay window).
// Deploy: npx supabase functions deploy handle-inbound-call --no-verify-jwt
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";

const TELNYX_API = "https://api.telnyx.com/v2";
const TELNYX_KEY = Deno.env.get("TELNYX_API_KEY")!;
const SUPA_URL = Deno.env.get("APP_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL")!;
const SUPA_SERVICE_KEY = Deno.env.get("APP_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPA_URL, SUPA_SERVICE_KEY);

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── Telnyx REST ─────────────────────────────────────────────────────────────

async function callAction(
  callControlId: string,
  action: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  const res = await fetch(`${TELNYX_API}/calls/${callControlId}/actions/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TELNYX_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text();
    const msg = `Telnyx ${action} ${res.status}: ${text.slice(0, 400)}`;
    // TEMP debug — action failures land here (console logs aren't shipped)
    await supabase.schema("voice").from("webhook_debug")
      .insert({ call_control_id: callControlId, event_type: `action:${action}`, error: msg })
      .then(() => {}).catch(() => {});
    throw new Error(msg);
  }
}

// ── Webhook signature (Ed25519) ─────────────────────────────────────────────
// Public key fetched once per isolate via GET /v2/public_key (data.public).

let _pubKey: CryptoKey | null = null;
async function telnyxPublicKey(): Promise<CryptoKey> {
  if (_pubKey) return _pubKey;
  const res = await fetch(`${TELNYX_API}/public_key`, {
    headers: { Authorization: `Bearer ${TELNYX_KEY}` },
  });
  const j = await res.json();
  const b64 = (j?.data?.public ?? j?.public) as string | undefined;
  if (!b64) throw new Error("Telnyx public key missing from response");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  _pubKey = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  return _pubKey;
}

async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  const sig = req.headers.get("telnyx-signature-ed25519");
  const ts = req.headers.get("telnyx-timestamp");
  if (!sig || !ts) return false;
  const t = parseInt(ts, 10);
  if (!Number.isFinite(t) || Math.abs(Math.floor(Date.now() / 1000) - t) > 300) return false;
  try {
    const key = await telnyxPublicKey();
    const sigBytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    const msg = new TextEncoder().encode(`${ts}|${rawBody}`);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, msg);
  } catch (e) {
    console.error("signature verify error:", e);
    return false;
  }
}

// ── Routing helpers ─────────────────────────────────────────────────────────

function normalizeE164(v: unknown): string {
  const d = String(v ?? "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return d;
}

async function poolExceeded(orgId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_pool_exceeded", { p_org: orgId, p_service: "voice" });
  if (error) {
    console.error("is_pool_exceeded error (failing open):", error.message);
    return false;
  }
  return data === true;
}

// No hours configured → answer anytime (fail open). Bad timezone → answer.
async function isAfterHours(orgId: string): Promise<boolean> {
  const { data: org } = await supabase
    .schema("core").from("organizations")
    .select("business_hours_timezone, business_hours(day_of_week, is_open, open_time, close_time)")
    .eq("id", orgId)
    .single();
  const hours = (org?.business_hours as Array<Record<string, unknown>>) || [];
  if (!hours.length) return false;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: (org?.business_hours_timezone as string) || "UTC",
      weekday: "long", hour: "numeric", minute: "numeric", hour12: false,
    }).formatToParts(new Date());
  } catch {
    return false;
  }
  const dayIdx = DAY_NAMES.indexOf(String(parts.find((p) => p.type === "weekday")?.value));
  const hour = parseInt(String(parts.find((p) => p.type === "hour")?.value), 10) % 24;
  const minute = parseInt(String(parts.find((p) => p.type === "minute")?.value), 10);
  if (dayIdx < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const mins = hour * 60 + minute;

  const today = hours.find((h) => h.day_of_week === dayIdx);
  if (!today?.is_open) return true;
  const [oh, om] = String(today.open_time).split(":").map(Number);
  const [ch, cm] = String(today.close_time).split(":").map(Number);
  return mins < oh * 60 + om || mins >= ch * 60 + cm;
}

// ── Event handlers ──────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Payload = any;

// Horus-side cost rates ($/min), measured in Phase 0 (2026-09-13, $0.0785/min
// blended toll-free). No per-call CDR/token endpoint exists (404s), so cost_usd
// is computed from duration at these rates — engine bundles STT+TTS.
const COST_ENGINE_PER_MIN = 0.05;
const COST_TELEPHONY_TOLLFREE_PER_MIN = 0.022;
const COST_TELEPHONY_LOCAL_PER_MIN = 0.0032;
const COST_RECORDING_PER_MIN = 0.002;
const COST_LLM_PER_MIN = 0.0045; // Kimi K2.6, ~90% cached turns (measured avg)
const TOLL_FREE_NPAS = new Set(["800", "888", "877", "866", "855", "844", "833"]);

function estimateCostUsd(durationSeconds: number, toNumber: string, aiEngaged: boolean, recorded: boolean): number {
  const mins = durationSeconds / 60;
  const npa = String(toNumber).replace(/^\+1/, "").slice(0, 3);
  let rate = TOLL_FREE_NPAS.has(npa) ? COST_TELEPHONY_TOLLFREE_PER_MIN : COST_TELEPHONY_LOCAL_PER_MIN;
  if (aiEngaged) rate += COST_ENGINE_PER_MIN + COST_LLM_PER_MIN;
  if (recorded) rate += COST_RECORDING_PER_MIN;
  return Math.round(mins * rate * 10000) / 10000;
}

// Resolve the caller to a CRM contact by phone alias (digits-only hash —
// generated column). Creates contact + alias on first call.
async function resolveVoiceContact(orgId: string, phoneE164: string): Promise<string | null> {
  const digits = phoneE164.replace(/\D/g, "");
  if (!digits) return null;
  const { data: alias } = await supabase
    .schema("crm").from("contact_aliases")
    .select("contact_id")
    .eq("organization_id", orgId)
    .eq("alias_type", "phone")
    .eq("alias_hash", digits)
    .maybeSingle();
  if (alias) {
    await supabase.schema("crm").from("contacts")
      .update({ last_seen_at: new Date().toISOString() }).eq("id", alias.contact_id);
    return alias.contact_id as string;
  }
  const { data: contact, error } = await supabase
    .schema("crm").from("contacts")
    .insert({ organization_id: orgId, primary_phone: phoneE164 })
    .select("id").single();
  if (error || !contact) {
    console.error("contact create failed:", error?.message);
    return null;
  }
  await supabase.schema("crm").from("contact_aliases").insert({
    contact_id: contact.id,
    organization_id: orgId,
    alias_type: "phone",
    alias_value: phoneE164,
    source: "inbound_call",
  });
  return contact.id as string;
}

async function onInitiated(p: Payload): Promise<void> {
  if (p.direction !== "incoming") return; // outbound legs (our transfers) — ignore
  const ccid = p.call_control_id as string;
  const to = normalizeE164(p.to);
  const from = normalizeE164(p.from);

  const { data: num } = await supabase
    .schema("voice").from("phone_numbers")
    .select("organization_id")
    .eq("phone_number", to).eq("status", "active")
    .maybeSingle();

  if (!num) {
    // Number points at our app but isn't managed (or was released) — reject
    // without answering so the caller gets a reorder tone, not a bill.
    console.warn(`call to unmanaged number ${to}`);
    await callAction(ccid, "hangup").catch(() => {});
    return;
  }

  const orgId = num.organization_id as string;
  const { data: cfg } = await supabase
    .schema("voice").from("configs").select("*")
    .eq("organization_id", orgId).maybeSingle();

  // ── Path decision (re-derived at call.answered from the row's outcome) ──
  let aiPath = true;
  if (!cfg?.enabled || !cfg?.telnyx_assistant_id) aiPath = false;
  else if (await poolExceeded(orgId)) aiPath = false;
  else if (cfg.after_hours_mode === "fallback" && await isAfterHours(orgId)) aiPath = false;

  const mode = aiPath ? "ai" : (cfg?.fallback_mode === "forward" && cfg?.fallback_number ? "forward" : "voicemail");

  // Idempotent row (telnyx_call_control_id UNIQUE — webhook retries are safe)
  await supabase.schema("voice").from("calls").upsert({
    organization_id: orgId,
    telnyx_call_control_id: ccid,
    direction: "inbound",
    from_number: from,
    to_number: to,
    assistant_id: mode === "ai" ? cfg!.telnyx_assistant_id : null,
    outcome: mode === "ai" ? null : mode === "forward" ? "forwarded" : "voicemail",
  }, { onConflict: "telnyx_call_control_id", ignoreDuplicates: true });

  await callAction(ccid, "answer");
}

async function onAnswered(p: Payload): Promise<void> {
  // NOTE: call.answered payloads carry NO direction field (verified live
  // 2026-09-14) — untracked outbound legs are filtered by the row lookup.
  const ccid = p.call_control_id as string;

  const { data: call } = await supabase
    .schema("voice").from("calls")
    .select("id, organization_id, outcome, answered_at")
    .eq("telnyx_call_control_id", ccid).maybeSingle();
  if (!call) return; // not a call we're tracking

  if (!call.answered_at) {
    await supabase.schema("voice").from("calls")
      .update({ answered_at: new Date().toISOString() }).eq("id", call.id);
  }

  const { data: cfg } = await supabase
    .schema("voice").from("configs").select("*")
    .eq("organization_id", call.organization_id).maybeSingle();
  if (!cfg) { await callAction(ccid, "hangup").catch(() => {}); return; }

  if (call.outcome === "forwarded") {
    await callAction(ccid, "transfer", {
      to: cfg.fallback_number,
      from: normalizeE164(p.to), // ring from the number the customer dialed
      timeout_secs: 30,
    });
  } else if (call.outcome === "voicemail") {
    // Greeting spoken in the org's chosen voice; recording starts on speak.ended
    await callAction(ccid, "speak", {
      payload: cfg.voicemail_greeting,
      voice: cfg.tts_voice,
      language: "en-US",
    });
  } else if (cfg.telnyx_assistant_id) {
    await callAction(ccid, "ai_assistant_start", { assistant_id: cfg.telnyx_assistant_id });
  } else {
    await callAction(ccid, "hangup").catch(() => {});
  }
}

async function onSpeakEnded(p: Payload): Promise<void> {
  const ccid = p.call_control_id as string;
  const { data: call } = await supabase
    .schema("voice").from("calls")
    .select("id, outcome")
    .eq("telnyx_call_control_id", ccid).maybeSingle();
  if (call?.outcome === "voicemail") {
    await callAction(ccid, "record_start", { format: "mp3", channels: "single", play_beep: true, max_length: 180 });
  }
}

async function onRecordingSaved(p: Payload): Promise<void> {
  const ccid = p.call_control_id as string;
  const url = (p.recording_urls?.mp3 || p.recording_urls?.wav) as string | undefined;
  if (!url) return;
  await supabase.schema("voice").from("calls")
    .update({ recording_url: url })
    .eq("telnyx_call_control_id", ccid).is("recording_url", null);
}

async function onHangup(p: Payload): Promise<void> {
  const ccid = p.call_control_id as string;
  const { data: call } = await supabase
    .schema("voice").from("calls")
    .select("id, organization_id, outcome, answered_at, ended_at, assistant_id, to_number, credits_charged")
    .eq("telnyx_call_control_id", ccid).maybeSingle();
  if (!call || call.ended_at) return; // unknown or already finalized (retry-safe)

  const endedAt = new Date();
  const duration = call.answered_at
    ? Math.max(0, Math.round((endedAt.getTime() - new Date(call.answered_at as string).getTime()) / 1000))
    : 0;
  // AI calls: outcome refined later by conversation events (transcript/insights).
  const outcome = call.outcome ?? (call.answered_at ? "completed" : "abandoned");

  // Cost + credits — only for answered calls. Credits burn in WHOLE minutes
  // (carrier-style) at the org's voice rate; cost_usd uses exact duration.
  const aiEngaged = !!call.assistant_id;
  const recorded = aiEngaged || call.outcome === "voicemail";
  let credits = 0;
  if (duration > 0) {
    const minutes = Math.ceil(duration / 60);
    const { data: svc } = await supabase
      .schema("core").from("org_services").select("credit_cost")
      .eq("organization_id", call.organization_id).eq("service", "voice").maybeSingle();
    credits = minutes * ((svc?.credit_cost as number) || 10);
    const { error: burnErr } = await supabase.rpc("increment_pool_usage", {
      p_org: call.organization_id,
      p_service: "voice",
      p_amount: credits,
    });
    if (burnErr) console.error(`credit burn failed for call ${call.id}:`, burnErr.message);
  }

  await supabase.schema("voice").from("calls").update({
    ended_at: endedAt.toISOString(),
    duration_seconds: duration,
    outcome,
    hangup_reason: (p.hangup_cause as string) ?? null,
    engine_minutes: aiEngaged ? Math.round((duration / 60) * 100) / 100 : 0,
    cost_usd: estimateCostUsd(duration, call.to_number as string, aiEngaged, recorded),
    credits_charged: credits,
  }).eq("id", call.id);
}

// Assistant conversation ended → archive the transcript into the customer's
// inbox (messaging, channel 'voice'), link it on the call row, grab the
// engine recording. Retry-safe: skips when the call row is already linked.
async function onConversationEnded(p: Payload): Promise<void> {
  const conversationId = (p.conversation_id ?? p.id) as string | undefined;
  let ccid = p.call_control_id as string | undefined;
  if (!conversationId) return;

  if (!ccid) {
    // Fall back to the conversation's metadata for the call linkage
    const raw = await telnyxGet(`/ai/conversations/${conversationId}`);
    ccid = (raw?.metadata?.call_control_id) as string | undefined;
  }
  if (!ccid) { console.warn(`conversation ${conversationId}: no call_control_id`); return; }

  const { data: call } = await supabase
    .schema("voice").from("calls")
    .select("id, organization_id, from_number, conversation_id, recording_url")
    .eq("telnyx_call_control_id", ccid).maybeSingle();
  if (!call) { console.warn(`conversation ${conversationId}: no call row for ${ccid}`); return; }
  if (call.conversation_id) return; // already archived (webhook retry)

  // ── Transcript ──
  const msgsRaw = await telnyxGet(`/ai/conversations/${conversationId}/messages`);
  const msgs = (Array.isArray(msgsRaw) ? msgsRaw : []) as Array<Record<string, unknown>>;

  const contactId = await resolveVoiceContact(call.organization_id as string, call.from_number as string);

  const { data: convo, error: convErr } = await supabase
    .schema("messaging").from("conversations")
    .upsert({
      organization_id: call.organization_id,
      contact_id: contactId,
      channel: "voice",
      external_thread_id: ccid,
      customer_phone: call.from_number,
      status: "active",
      ai_enabled: true,
    }, { onConflict: "organization_id,channel,external_thread_id" })
    .select("id")
    .single();
  if (convErr || !convo) throw new Error(`conversation upsert failed: ${convErr?.message}`);

  // Idempotent transcript insert — skip if the conversation already has rows
  const { count } = await supabase
    .schema("messaging").from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", convo.id);
  if (!count && msgs.length) {
    const rows = msgs
      .filter((m) => (m.role === "assistant" || m.role === "user") && m.text)
      .map((m, i) => ({
        conversation_id: convo.id,
        organization_id: call.organization_id,
        role: m.role === "assistant" ? "ai" : "customer",
        content: String(m.text),
        status: "sent",
        sent_at: (m.sent_at as string) ?? null,
        external_message_id: `${conversationId}:${i}`,
      }));
    if (rows.length) {
      const { error: msgErr } = await supabase.schema("messaging").from("messages").insert(rows);
      if (msgErr) throw new Error(`transcript insert failed: ${msgErr.message}`);
    }
  }

  // ── Engine recording (dual-channel mp3 from the assistant) ──
  // NOTE: the download URL is S3-presigned (~10 min TTL) — permanent storage
  // in Supabase Storage is a separate follow-up bite.
  let recordingUrl = call.recording_url as string | null;
  if (!recordingUrl) {
    const conv = await telnyxGet(`/ai/conversations/${conversationId}`);
    const legId = conv?.metadata?.call_leg_id as string | undefined;
    if (legId) {
      const recs = await telnyxGet(`/recordings?filter[call_leg_id]=${legId}`);
      const rec = (Array.isArray(recs) ? recs : [])[0] as Record<string, unknown> | undefined;
      recordingUrl = ((rec?.download_urls as Record<string, unknown>)?.mp3 as string) ?? null;
    }
  }

  await supabase.schema("voice").from("calls").update({
    conversation_id: convo.id,
    recording_url: recordingUrl,
  }).eq("id", call.id);
}

// Structured post-call analysis → conversation summary (best effort; payload
// shape not yet observed live — log keys on first events to refine).
async function onInsightsGenerated(p: Payload): Promise<void> {
  console.log("insights payload keys:", Object.keys(p || {}).join(","));
  const conversationId = (p.conversation_id ?? p.id) as string | undefined;
  const summary = (p.insights?.summary ?? p.summary ?? null) as string | null;
  if (!conversationId || !summary) return;
  const ccid = p.call_control_id as string | undefined;
  if (!ccid) return;
  const { data: call } = await supabase
    .schema("voice").from("calls")
    .select("conversation_id")
    .eq("telnyx_call_control_id", ccid).maybeSingle();
  if (!call?.conversation_id) return;
  await supabase.schema("messaging").from("conversations")
    .update({ summary })
    .eq("id", call.conversation_id)
    .is("summary", null);
}

// Thin Telnyx GET helper — returns the unwrapped data payload (shapes are
// inconsistent: some endpoints wrap in .data, some don't).
async function telnyxGet(path: string): Promise<Payload> {
  const res = await fetch(`${TELNYX_API}${path}`, {
    headers: { Authorization: `Bearer ${TELNYX_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telnyx GET ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  const j = await res.json();
  return j.data ?? j;
}

// ── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  const rawBody = await req.text();
  if (!(await verifySignature(req, rawBody))) {
    return new Response(JSON.stringify({ error: "invalid signature" }), { status: 403 });
  }

  let event: Payload;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }

  const type = event?.data?.event_type as string | undefined;
  const p = event?.data?.payload ?? {};

  // TEMP debug — record every verified event
  await supabase.schema("voice").from("webhook_debug").insert({
    event_type: type ?? "unknown",
    call_control_id: p?.call_control_id ?? null,
    direction: p?.direction ?? null,
    payload: p ?? null,
  }).then(() => {}).catch(() => {});

  try {
    switch (type) {
      case "call.initiated": await onInitiated(p); break;
      case "call.answered": await onAnswered(p); break;
      case "call.speak.ended": await onSpeakEnded(p); break;
      case "call.recording.saved": await onRecordingSaved(p); break;
      case "call.conversation.ended": await onConversationEnded(p); break;
      case "call.conversation_insights.generated": await onInsightsGenerated(p); break;
      case "call.hangup": await onHangup(p); break;
      default: break; // acknowledge everything else
    }
  } catch (e) {
    // Still 200 — action failures must not trigger Telnyx retry storms
    console.error(`handle-inbound-call error [${type}]:`, e);
    // TEMP debug
    await supabase.schema("voice").from("webhook_debug")
      .insert({ event_type: `error:${type}`, call_control_id: p?.call_control_id ?? null, error: String(e) })
      .then(() => {}).catch(() => {});
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
