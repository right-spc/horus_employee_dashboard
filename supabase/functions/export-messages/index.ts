// ============================================
// EDGE FUNCTION: export-messages
//
// Generates a CSV of an org's messages over a given window, uploads it to
// the private "message-exports" Supabase Storage bucket, and (optionally)
// emails a 7-day signed download link to a recipient that's already tied
// to the org (the connected inbox or one of its notification_recipients).
//
// Designed to be called internally with the service-role key from:
//   - dashboard-api ("export_messages" action)
//   - cron-maintenance Task 6 (scheduled exports)
//   - customer-api (future, for self-serve customer downloads)
//
// Auth: rejects any request that does not present the service role key.
// Deploy with --no-verify-jwt because the JWT here is the service key,
// not a user JWT.
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_WINDOW_DAYS = 366;

interface ExportRequest {
  org_id: string;
  start_date: string;
  end_date: string;
  recipient_email?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── Auth: only the service role key may invoke this function ──────────────
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${serviceKey}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: ExportRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { org_id, start_date, end_date, recipient_email } = body;
  if (!org_id || !start_date || !end_date) {
    return json({ error: "Missing org_id / start_date / end_date" }, 400);
  }

  const startMs = Date.parse(start_date);
  const endMs = Date.parse(end_date);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return json({ error: "start_date / end_date must be ISO 8601" }, 400);
  }
  if (endMs <= startMs) {
    return json({ error: "end_date must be after start_date" }, 400);
  }
  if (endMs - startMs > MAX_WINDOW_DAYS * 86400000) {
    return json({ error: `Window too large (max ${MAX_WINDOW_DAYS} days)` }, 400);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  // ── 1. Query messages ─────────────────────────────────────────────────────
  const { data: messages, error: msgErr } = await supabase
    .from("messages")
    .select(`
      created_at, role, content, status, routing_code,
      escalation_type, lead_priority,
      review_reason, reviewed_by, reviewed_at, review_notes
    `)
    .eq("organization_id", org_id)
    .gte("created_at", new Date(startMs).toISOString())
    .lt("created_at", new Date(endMs).toISOString())
    .order("created_at", { ascending: true });

  if (msgErr) {
    console.error("[export-messages] message query failed:", msgErr.message);
    return json({ error: `Failed to load messages: ${msgErr.message}` }, 500);
  }

  // ── 2. Build CSV ──────────────────────────────────────────────────────────
  const csvText = buildCsv(messages ?? []);
  const messageCount = messages?.length ?? 0;

  // ── 3. Upload to Storage ──────────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${org_id}/${timestamp}.csv`;

  const { error: uploadErr } = await supabase.storage
    .from("message-exports")
    .upload(path, new Blob([csvText], { type: "text/csv" }), {
      contentType: "text/csv",
      upsert: false,
    });

  if (uploadErr) {
    console.error("[export-messages] upload failed:", uploadErr.message);
    return json({ error: `Upload failed: ${uploadErr.message}` }, 500);
  }

  const { data: signed, error: signErr } = await supabase.storage
    .from("message-exports")
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (signErr || !signed) {
    console.error("[export-messages] sign failed:", signErr?.message);
    return json({ error: "Failed to create signed URL" }, 500);
  }

  const url = signed.signedUrl;
  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();

  // ── 4. Optionally email the link ──────────────────────────────────────────
  if (recipient_email) {
    // Validate recipient is actually tied to this org
    const allowed = await isAuthorizedRecipient(supabase, org_id, recipient_email);
    if (!allowed) {
      return json(
        { error: "recipient_email is not authorized for this org" },
        400
      );
    }

    try {
      await sendDownloadLinkEmail(supabase, org_id, recipient_email, {
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(endMs).toISOString(),
        messageCount,
        url,
        expiresAt,
      });
    } catch (e) {
      console.error("[export-messages] email send failed:", (e as Error).message);
      // Don't fail the whole request — the URL is still returned and usable.
      return json({
        success: true,
        url,
        message_count: messageCount,
        expires_at: expiresAt,
        path,
        email_sent: false,
        email_error: (e as Error).message,
      });
    }
  }

  return json({
    success: true,
    url,
    message_count: messageCount,
    expires_at: expiresAt,
    path,
    email_sent: !!recipient_email,
  });
});

// ── CSV builder ──────────────────────────────────────────────────────────────

interface MessageRow {
  created_at: string;
  role: string;
  content: string;
  status: string;
  routing_code: string | null;
  escalation_type: string | null;
  lead_priority: string | null;
  review_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
}

function buildCsv(rows: MessageRow[]): string {
  const headers = [
    "created_at",
    "role",
    "content",
    "status",
    "message_type",
    "escalation_type",
    "lead_priority",
    "review_reason",
    "reviewed_by",
    "reviewed_at",
    "review_notes",
  ];

  const lines: string[] = [headers.join(",")];

  for (const r of rows) {
    const messageType = formatMessageType(r.routing_code);
    const escalationType = formatEscalationType(r.escalation_type);
    const leadPriority = r.escalation_type === "lead" ? (r.lead_priority ?? "") : "";

    lines.push([
      csvEscape(r.created_at),
      csvEscape(r.role),
      csvEscape(r.content),
      csvEscape(r.status),
      csvEscape(messageType),
      csvEscape(escalationType),
      csvEscape(leadPriority),
      csvEscape(r.review_reason),
      csvEscape(r.reviewed_by),
      csvEscape(r.reviewed_at),
      csvEscape(r.review_notes),
    ].join(","));
  }

  return lines.join("\r\n") + "\r\n";
}

function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatMessageType(routingCode: string | null): string {
  if (!routingCode) return "";
  switch (routingCode.toLowerCase()) {
    case "draft": return "normal";
    case "escalate": return "escalate";
    case "ignore": return "ignore";
    default: return routingCode;
  }
}

function formatEscalationType(escalationType: string | null): string {
  if (!escalationType) return "";
  switch (escalationType.toLowerCase()) {
    case "kb_gap": return "missing info";
    case "frustrated": return "frustrated";
    case "lead": return "lead";
    default: return escalationType;
  }
}

// ── Recipient validation ─────────────────────────────────────────────────────

async function isAuthorizedRecipient(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  email: string
): Promise<boolean> {
  const target = email.trim().toLowerCase();

  const { data: provider } = await supabase
    .from("email_providers")
    .select("provider_account_email")
    .eq("organization_id", orgId)
    .eq("status", "active")
    .maybeSingle();

  if (provider?.provider_account_email?.toLowerCase() === target) return true;

  const { data: recip } = await supabase
    .from("notification_recipients")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .ilike("email", target)
    .maybeSingle();

  return !!recip;
}

// ── Email sender (single recipient variant of sendOrgNotification) ───────────

interface EmailContext {
  startIso: string;
  endIso: string;
  messageCount: number;
  url: string;
  expiresAt: string;
}

async function sendDownloadLinkEmail(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  toEmail: string,
  ctx: EmailContext
): Promise<void> {
  const { data: provider } = await supabase
    .from("email_providers")
    .select("id, provider, provider_account_email, access_token_encrypted, refresh_token_encrypted, token_expires_at")
    .eq("organization_id", orgId)
    .eq("status", "active")
    .maybeSingle();

  if (!provider) {
    throw new Error(`No active email provider for org ${orgId}`);
  }

  const accessToken = await getAccessToken(
    supabase,
    provider as Record<string, unknown>,
    provider.provider as "google" | "microsoft"
  );

  const subject = "Your Horus Desk message export is ready";
  const body = [
    `Your message export is ready to download.`,
    ``,
    `Date range: ${formatHumanDate(ctx.startIso)} → ${formatHumanDate(ctx.endIso)}`,
    `Messages included: ${ctx.messageCount.toLocaleString()}`,
    ``,
    `Download link (expires ${formatHumanDate(ctx.expiresAt)}):`,
    ctx.url,
    ``,
    `If the link has expired, request a fresh export from your dashboard.`,
    ``,
    `— Horus Desk`,
  ].join("\n");

  if (provider.provider === "google") {
    const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
    const rawEmail = [
      `From: ${provider.provider_account_email}`,
      `To: ${toEmail}`,
      `Subject: ${encodedSubject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body,
    ].join("\r\n");

    const encodedEmail = btoa(unescape(encodeURIComponent(rawEmail)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: encodedEmail }),
    });
    if (!res.ok) {
      throw new Error(`Gmail send failed: ${await res.text()}`);
    }
  } else if (provider.provider === "microsoft") {
    const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "Text", content: body },
          toRecipients: [{ emailAddress: { address: toEmail } }],
        },
        saveToSentItems: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`Graph send failed: ${await res.text()}`);
    }
  } else {
    throw new Error(`Unsupported provider: ${provider.provider}`);
  }
}

function formatHumanDate(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().slice(0, 10);
}

// ── Token helper (copied from cron-maintenance — no shared modules) ─────────

async function getAccessToken(
  supabase: ReturnType<typeof createClient>,
  provider: Record<string, unknown>,
  providerType: "google" | "microsoft"
): Promise<string> {

  async function getKey(secret: string): Promise<CryptoKey> {
    const keyData = encoder.encode(secret);
    const hash = await crypto.subtle.digest("SHA-256", keyData);
    return await crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async function decrypt(encryptedValue: string, key: CryptoKey): Promise<string> {
    let base64: string;
    if (encryptedValue.startsWith("\\x")) {
      const hex = encryptedValue.slice(2);
      base64 = decoder.decode(
        new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
      );
    } else {
      base64 = encryptedValue;
    }
    const combined = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return decoder.decode(decrypted);
  }

  async function encrypt(text: string, key: CryptoKey): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key, encoder.encode(text)
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  }

  const encryptionKey = await getKey(Deno.env.get("TOKEN_ENCRYPTION_KEY")!);
  const now = new Date();
  const expiresAt = provider.token_expires_at
    ? new Date(provider.token_expires_at as string) : null;

  if (
    provider.access_token_encrypted &&
    expiresAt &&
    expiresAt > new Date(now.getTime() + 5 * 60 * 1000)
  ) {
    return await decrypt(provider.access_token_encrypted as string, encryptionKey);
  }

  const refreshToken = await decrypt(
    provider.refresh_token_encrypted as string,
    encryptionKey
  );

  let tokenResponse: Response;

  if (providerType === "google") {
    tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
        client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } else {
    tokenResponse = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: Deno.env.get("MICROSOFT_CLIENT_ID")!,
          client_secret: Deno.env.get("MICROSOFT_CLIENT_SECRET")!,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
          scope: [
            "https://graph.microsoft.com/Mail.Read",
            "https://graph.microsoft.com/Mail.Send",
            "https://graph.microsoft.com/User.Read",
            "offline_access",
          ].join(" "),
        }),
      }
    );
  }

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    await supabase
      .from("email_providers")
      .update({ status: "expired", error_message: `Token refresh failed: ${err}` })
      .eq("id", provider.id);
    throw new Error(`Token refresh failed: ${err}`);
  }

  const tokens = await tokenResponse.json();
  const newExpiry = new Date(now.getTime() + tokens.expires_in * 1000);
  const encryptedNewAccess = await encrypt(tokens.access_token, encryptionKey);

  await supabase
    .from("email_providers")
    .update({
      access_token_encrypted: encryptedNewAccess,
      token_expires_at: newExpiry.toISOString(),
      status: "active",
      error_message: null,
    })
    .eq("id", provider.id);

  return tokens.access_token;
}

// ── Response helper ──────────────────────────────────────────────────────────

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
