// ============================================================
// EDGE FUNCTION: webhook-handler
// Receives Resend webhook batches (opens, clicks, bounces,
// complaints, deliveries, and inbound replies) and writes them to
// marketing.email_events plus updates marketing.campaign_sends and
// suppresses bad contacts.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SUPA_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_HORUS_CAMPAIGNS_KEY") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SUPPORTED_EVENT_TYPES = new Set([
  "sent",
  "delivered",
  "open",
  "click",
  "bounce",
  "complaint",
  "unsubscribe",
]);

function extractEmailAddress(from: string | null | undefined): string | null {
  if (!from) return null;
  const match = from.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase().trim();
  return from.toLowerCase().trim();
}

function collectThreadReferences(headers: Record<string, string>): Set<string> {
  const refs = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const matches = value.match(/<([^>]+)>/g);
    if (!matches) return;
    for (const m of matches) refs.add(m.slice(1, -1));
  };
  add(headers["in-reply-to"] ?? headers["In-Reply-To"]);
  add(headers["references"] ?? headers["References"]);
  return refs;
}

async function processInboundReply(
  event: any,
  supabase: any,
): Promise<boolean> {
  const emailId = event?.data?.email_id;
  if (!emailId) return false;
  if (!RESEND_API_KEY) {
    console.log("Skipping inbound reply: RESEND_HORUS_CAMPAIGNS_KEY not configured");
    return false;
  }

  const inboundRes = await fetch(
    `https://api.resend.com/emails/receiving/${emailId}`,
    { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } },
  );
  if (!inboundRes.ok) {
    console.error("Failed to fetch inbound email:", inboundRes.status, await inboundRes.text());
    return false;
  }
  const inbound = await inboundRes.json();

  const fromEmail = extractEmailAddress(inbound.from);
  const subject = inbound.subject ?? null;
  const headers = (inbound.headers ?? {}) as Record<string, string>;
  const refs = collectThreadReferences(headers);

  let send: any = null;

  // 1. Try to match by In-Reply-To / References thread message ID.
  if (refs.size > 0) {
    const { data } = await supabase
      .from("campaign_sends")
      .select("id, contact_id, campaign_id, step_id")
      .in("thread_message_id", Array.from(refs))
      .is("replied_at", null)
      .maybeSingle();
    send = data;
  }

  // 2. Fallback: match by sender email to the most recent sent send for the contact.
  if (!send && fromEmail) {
    const { data: contact } = await supabase
      .schema("crm").from("contacts")
      .select("id")
      .ilike("email", fromEmail)
      .maybeSingle();

    if (contact?.id) {
      const { data } = await supabase
        .from("campaign_sends")
        .select("id, contact_id, campaign_id, step_id")
        .eq("contact_id", contact.id)
        .eq("status", "sent")
        .is("replied_at", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      send = data;
    }
  }

  if (!send) {
    console.log(
      "No matching campaign_send for inbound reply:",
      emailId,
      "refs:",
      Array.from(refs),
    );
    return false;
  }

  const now = new Date().toISOString();

  // Log the reply event.
  const { error: logError } = await supabase.from("email_events").insert({
    contact_id: send.contact_id,
    campaign_id: send.campaign_id,
    step_id: send.step_id,
    campaign_send_id: send.id,
    event_type: "reply",
    metadata: {
      inbound_email_id: emailId,
      from: inbound.from,
      to: inbound.to,
      subject,
      message_id: inbound.message_id,
      thread_references: Array.from(refs),
    },
  });
  if (logError) {
    console.error("email_events reply insert failed:", logError);
  }

  // Mark the originating send as replied.
  const { error: updError } = await supabase.from("campaign_sends")
    .update({ replied_at: now })
    .eq("id", send.id);
  if (updError) {
    console.error("campaign_sends replied_at update failed:", updError);
  }

  // Cancel pending follow-ups for this contact/campaign now that they replied.
  const { error: cancelError } = await supabase.from("campaign_sends")
    .update({ status: "cancelled", error_msg: "Lead replied" })
    .eq("contact_id", send.contact_id)
    .eq("campaign_id", send.campaign_id)
    .eq("status", "pending");
  if (cancelError) {
    console.error("Failed to cancel pending follow-ups after reply:", cancelError);
  }

  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Resend does not support custom headers, so we use a query param secret
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const rawPayload = await req.json().catch(() => null);
  const events = Array.isArray(rawPayload)
    ? rawPayload
    : rawPayload && typeof rawPayload === "object"
    ? [rawPayload]
    : null;
  if (!events) {
    return new Response("Bad Request: expected object or array of events", { status: 400 });
  }

  const supabase = createClient(SUPA_URL, SUPA_SERVICE_KEY, {
    db: { schema: "marketing" },
  });
  const globalClient = createClient(SUPA_URL, SUPA_SERVICE_KEY, {
    db: { schema: "global" },
  });

  let processed = 0;
  let skipped = 0;

  for (const event of events) {
    // Map Resend event types to our schema
    const rawType = String(event.type ?? "").replace(/^email\./, "");
    const eventType = rawType === "complained"
      ? "complaint"
      : rawType === "bounced"
      ? "bounce"
      : rawType === "opened"
      ? "open"
      : rawType === "clicked"
      ? "click"
      : rawType;

    // Handle inbound reply events separately.
    if (eventType === "received") {
      const ok = await processInboundReply(event, supabase);
      if (ok) processed++;
      else skipped++;
      continue;
    }

    const messageId = event?.data?.id ?? event?.data?.email_id;
    if (!messageId) {
      skipped++;
      continue;
    }

    if (!SUPPORTED_EVENT_TYPES.has(eventType)) {
      console.log("Unsupported event type, skipping:", event.type);
      skipped++;
      continue;
    }

    // Find the send record by Resend message ID
    const { data: send, error: sendError } = await supabase
      .from("campaign_sends")
      .select("id, contact_id, campaign_id, step_id, status")
      .eq("resend_message_id", messageId)
      .maybeSingle();

    if (sendError) {
      console.error("Lookup error:", sendError);
      skipped++;
      continue;
    }

    if (!send) {
      console.log("No campaign_send found for message ID:", messageId);
      skipped++;
      continue;
    }

    // Extract bounce details if present
    const bounce = event?.data?.bounce;
    const bounceType = eventType === "bounce" ? bounce?.type ?? null : null;
    const bounceReason = eventType === "bounce" ? bounce?.message ?? null : null;

    // Log the event
    const { error: logError } = await supabase.from("email_events").insert({
      contact_id: send.contact_id,
      campaign_id: send.campaign_id,
      step_id: send.step_id,
      campaign_send_id: send.id,
      event_type: eventType,
      bounce_type: bounceType,
      bounce_reason: bounceReason,
      metadata: event,
    });

    if (logError) {
      console.error("email_events insert failed:", logError);
    }

    // Update campaign_sends and suppress bad contacts
    const updates: Record<string, unknown> = {};
    const now = new Date().toISOString();

    if (eventType === "open") updates.opened_at = now;
    if (eventType === "click") updates.clicked_at = now;

    if (eventType === "unsubscribe") {
      // Record the unsubscribe and cancel any pending follow-ups.
      const { error: unsubError } = await supabase.from("email_unsubscribes").insert({
        email: send.email,
        campaign_id: send.campaign_id,
      });
      if (unsubError && !unsubError.message.includes("duplicate key")) {
        console.error("Unsubscribe insert failed:", unsubError);
      }

      await supabase.from("campaign_sends")
        .update({ status: "cancelled", error_msg: "Unsubscribed" })
        .eq("contact_id", send.contact_id)
        .eq("campaign_id", send.campaign_id)
        .eq("status", "pending");
    }

    if (eventType === "bounce" || eventType === "complaint") {
      // Record bounce in the global bounce list (source-of-truth).
      const email = (send.email ?? "").toLowerCase();

      updates.status = "failed";
      updates.error_msg = eventType === "bounce"
        ? (bounceReason ? `Bounced: ${bounceReason}` : "Bounced")
        : "Complaint";
      if (email) {
        const { error: bounceError } = await globalClient
          .from("bounced_emails")
          .upsert({
            email,
            bounced_at: new Date().toISOString(),
            bounce_type: eventType === "bounce" ? bounceType : "complaint",
            bounce_reason: bounceReason,
            source: "resend_webhook",
          }, { onConflict: "email" });
        if (bounceError) {
          console.error("Global bounce insert failed:", bounceError);
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      const { error: updError } = await supabase
        .from("campaign_sends")
        .update(updates)
        .eq("id", send.id);

      if (updError) {
        console.error("campaign_sends update failed:", updError);
      }
    }

    processed++;
  }

  return new Response(
    JSON.stringify({ ok: true, processed, skipped, total: events.length }),
    {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    },
  );
});
