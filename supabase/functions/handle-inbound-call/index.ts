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
    throw new Error(`Telnyx ${action} ${res.status}: ${text.slice(0, 200)}`);
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
  if (p.direction !== "incoming") return;
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
  if (p.direction !== "incoming") return;
  const ccid = p.call_control_id as string;
  const { data: call } = await supabase
    .schema("voice").from("calls")
    .select("id, outcome")
    .eq("telnyx_call_control_id", ccid).maybeSingle();
  if (call?.outcome === "voicemail") {
    await callAction(ccid, "record_start", { format: "mp3", channels: "single" });
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
    .select("id, outcome, answered_at, ended_at")
    .eq("telnyx_call_control_id", ccid).maybeSingle();
  if (!call || call.ended_at) return; // unknown or already finalized (retry-safe)

  const endedAt = new Date();
  const duration = call.answered_at
    ? Math.max(0, Math.round((endedAt.getTime() - new Date(call.answered_at as string).getTime()) / 1000))
    : 0;
  // AI calls: outcome refined later by handle-call-events (transcript/insights).
  const outcome = call.outcome ?? (call.answered_at ? "completed" : "abandoned");

  await supabase.schema("voice").from("calls").update({
    ended_at: endedAt.toISOString(),
    duration_seconds: duration,
    outcome,
    hangup_reason: (p.hangup_cause as string) ?? null,
  }).eq("id", call.id);
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

  try {
    switch (type) {
      case "call.initiated": await onInitiated(p); break;
      case "call.answered": await onAnswered(p); break;
      case "call.speak.ended": await onSpeakEnded(p); break;
      case "call.recording.saved": await onRecordingSaved(p); break;
      case "call.hangup": await onHangup(p); break;
      default: break; // acknowledge everything else
    }
  } catch (e) {
    // Still 200 — action failures must not trigger Telnyx retry storms
    console.error(`handle-inbound-call error [${type}]:`, e);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
