// ============================================
// EDGE FUNCTION: process-delivery-queue
// Cron: runs every 2 minutes
// Picks up pending delivery_queue rows and
// dispatches them to the correct channel sender.
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

// ── Types ────────────────────────────────────
interface QueueRow {
  id: string;
  message_id: string;
  organization_id: string;
  provider: "google" | "microsoft" | "twilio" | "sendgrid";
  attempt_count: number;
  max_attempts: number;
  error_message: string | null;
}

interface MessageRow {
  id: string;
  content: string;
  conversation_id: string;
  external_message_id: string | null; // Original customer message ID (for threading)
}

interface ConversationRow {
  id: string;
  external_thread_id: string;   // Gmail threadId
  customer_email: string;
  subject: string | null;
}

interface ProviderRow {
  id: string;
  provider: string;
  provider_account_email: string;
  access_token_encrypted: Uint8Array | null;
  refresh_token_encrypted: Uint8Array;
  token_expires_at: string | null;
  daily_send_limit: number;
  emails_sent_today: number;
}

// ── Constants ────────────────────────────────
const BATCH_SIZE = 15;            // Max jobs to process per invocation
const STALE_JOB_MINUTES = 10;    // Reset processing jobs older than this

// ── Crypto Helpers ───────────────────────────
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function getKey(secret: string): Promise<CryptoKey> {
  const keyData = encoder.encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  return await crypto.subtle.importKey(
    "raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]
  );
}

async function decrypt(encryptedValue: string, key: CryptoKey): Promise<string> {
  // Supabase returns bytea columns with a \x hex prefix — strip it and decode from hex
  let base64: string;
  if (encryptedValue.startsWith("\\x")) {
    const hex = encryptedValue.slice(2);
    base64 = new TextDecoder().decode(
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

// ── Main Handler ─────────────────────────────
Deno.serve(async (req: Request) => {
  // Allow cron invocations (Supabase sends POST with no body)
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const results = {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    stale_reset: 0,
  };

  try {
    // ── 1. RECOVER STALE JOBS ──────────────────
    // Jobs stuck in 'processing' because a previous worker crashed
    const { data: staleReset } = await supabase.rpc(
      "recover_stale_delivery_jobs",
      { stale_after_minutes: STALE_JOB_MINUTES }
    );
    results.stale_reset = staleReset ?? 0;

    // ── 2. CLAIM A BATCH OF PENDING JOBS ───────
    // Atomic claim: set status to 'processing' so concurrent invocations
    // don't pick up the same jobs. Uses processing_started_at for stale detection.
    const { data: jobs, error: claimError } = await supabase
      .from("delivery_queue")
      .update({
        status: "processing",
        processing_started_at: new Date().toISOString(),
      })
      .eq("status", "pending")
      .lte("next_attempt_at", new Date().toISOString())
      .select("id, message_id, organization_id, provider, attempt_count, max_attempts, error_message")
      .limit(BATCH_SIZE)
      .returns<QueueRow[]>();

    if (claimError) {
      throw new Error(`Failed to claim queue jobs: ${claimError.message}`);
    }

    if (!jobs || jobs.length === 0) {
      // No delivery jobs — but still process escalation notifications below
    } else {

    // ── 3. PROCESS EACH JOB ────────────────────
    for (const job of jobs) {
      results.processed++;

      try {
        // Load the message
        const { data: message, error: msgError } = await supabase
          .from("messages")
          .select("id, content, conversation_id, external_message_id")
          .eq("id", job.message_id)
          .single<MessageRow>();

        if (msgError || !message) {
          await failJob(supabase, job, "Message not found — may have been deleted");
          results.failed++;
          continue;
        }

        // Load the conversation (for thread ID + recipient email)
        const { data: conversation, error: convError } = await supabase
          .from("conversations")
          .select("id, external_thread_id, customer_email, subject")
          .eq("id", message.conversation_id)
          .single<ConversationRow>();

        if (convError || !conversation) {
          await failJob(supabase, job, "Conversation not found");
          results.failed++;
          continue;
        }

        if (!conversation.customer_email) {
          await failJob(supabase, job, "No recipient email on conversation");
          results.failed++;
          continue;
        }

        // ── 4. DISPATCH BY CHANNEL ─────────────
        let providerMessageId: string | null = null;

        if (job.provider === "google") {
          providerMessageId = await sendViaGmail(supabase, job, message, conversation);
        } else if (job.provider === "microsoft") {
          providerMessageId = await sendViaMicrosoft(supabase, job, message, conversation);
        } else {
          // Future channels — stub for now
          await failJob(supabase, job, `Provider '${job.provider}' not yet implemented`);
          results.skipped++;
          continue;
        }

        // ── 5. MARK SUCCESS ────────────────────
        await supabase
          .from("delivery_queue")
          .update({
            status: "sent",
            provider_message_id: providerMessageId,
            completed_at: new Date().toISOString(),
            processing_started_at: null,
          })
          .eq("id", job.id);

        await supabase
          .from("messages")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            external_message_id: providerMessageId ?? message.external_message_id,
          })
          .eq("id", job.message_id);

        // Analytics
        await supabase.from("analytics_events").insert({
          organization_id: job.organization_id,
          event_type: "message_sent",
          metadata: {
            conversation_id: message.conversation_id,
            provider: job.provider,
            attempt_count: job.attempt_count + 1,
          },
        });

        results.sent++;
      } catch (jobError) {
        // Unexpected error on this job — retry later with exponential backoff
        await retryOrFail(supabase, job, jobError.message);
        results.failed++;
      }
    }
    } // end else (had delivery jobs)

    // ── 6. PROCESS PENDING ESCALATION NOTIFICATIONS ──
    // Widget-chat sets escalation_notify_at 10 min in the future to debounce
    // repeated escalations. When the time arrives, we send one consolidated email
    // with the full chat history.
    const escalationResults = await processEscalationNotifications(supabase);

    return new Response(
      JSON.stringify({ status: "ok", ...results, escalation_notifications_sent: escalationResults.sent }),
      { status: 200 }
    );
  } catch (error) {
    console.error("process-delivery-queue fatal error:", error);
    return new Response(
      JSON.stringify({ error: error.message, ...results }),
      { status: 500 }
    );
  }
});

// ── Gmail Sender ─────────────────────────────
async function sendViaGmail(
  supabase: ReturnType<typeof createClient>,
  job: QueueRow,
  message: MessageRow,
  conversation: ConversationRow
): Promise<string> {
  // Load provider credentials
  const provider = await loadProvider(supabase, job.organization_id, "google");

  // Check daily send limit
  if (provider.emails_sent_today >= provider.daily_send_limit) {
    throw new Error(
      `Daily send limit reached (${provider.daily_send_limit}) for ${provider.provider_account_email}`
    );
  }

  // Get a valid access token (refresh if needed)
  const accessToken = await getGmailAccessToken(supabase, provider);

  // Build RFC 2822 email, threading back into the Gmail thread
  const rawEmail = buildRfc2822Email({
    from: provider.provider_account_email,
    to: conversation.customer_email,
    subject: buildReplySubject(conversation.subject),
    body: message.content,
    threadId: conversation.external_thread_id,
    inReplyTo: message.external_message_id ?? undefined,
  });

  // Base64url encode (required by Gmail API).
  // Wrap in unescape(encodeURIComponent(...)) so btoa can handle non-Latin1
  // characters (emoji, accents, curly quotes) in the body or headers.
  const encodedEmail = btoa(unescape(encodeURIComponent(rawEmail)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // Send via Gmail API
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        raw: encodedEmail,
        threadId: conversation.external_thread_id, // Keep in same Gmail thread
      }),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gmail API error ${response.status}: ${errorBody}`);
  }

  const sent = await response.json();

  // Increment daily send counter
  await supabase
    .from("email_providers")
    .update({ emails_sent_today: provider.emails_sent_today + 1 })
    .eq("id", provider.id);

  return sent.id; // Gmail message ID
}

// ── Microsoft Outlook Sender ──────────────────
async function sendViaMicrosoft(
  supabase: ReturnType<typeof createClient>,
  job: QueueRow,
  message: MessageRow,
  conversation: ConversationRow
): Promise<string> {
  // Load provider credentials
  const provider = await loadProvider(supabase, job.organization_id, "microsoft");

  // Check daily send limit
  if (provider.emails_sent_today >= provider.daily_send_limit) {
    throw new Error(
      `Daily send limit reached (${provider.daily_send_limit}) for ${provider.provider_account_email}`
    );
  }

  // Get a valid access token (refresh if needed)
  const accessToken = await getMicrosoftAccessToken(supabase, provider);

  // Build the subject — prefix Re: if not already present
  const subject = conversation.subject
    ? conversation.subject.startsWith("Re:")
      ? conversation.subject
      : `Re: ${conversation.subject}`
    : "Re: your inquiry";

  // Send via Microsoft Graph sendMail endpoint
  // Graph handles threading automatically via conversationId when we set the
  // same conversationId on the message — no manual In-Reply-To headers needed.
  const sendBody = {
    message: {
      subject,
      body: {
        contentType: "Text",
        content: message.content,
      },
      toRecipients: [
        {
          emailAddress: {
            address: conversation.customer_email,
          },
        },
      ],
      // Threading: attach to the same Outlook conversation thread
      // This is done by including the conversationId on the outbound message.
      // Graph will thread it correctly in both Outlook and the recipient's client.
      internetMessageHeaders: message.external_message_id
        ? [
            {
              name: "In-Reply-To",
              value: message.external_message_id,
            },
            {
              name: "References",
              value: message.external_message_id,
            },
          ]
        : [],
    },
    // Do not save to Sent Items — keeps the business inbox clean.
    // Set to true if you want sent emails visible in Outlook's Sent folder.
    saveToSentItems: true,
  };

  const response = await fetch(
    "https://graph.microsoft.com/v1.0/me/sendMail",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sendBody),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Graph sendMail error ${response.status}: ${errorBody}`);
  }

  // Graph sendMail returns 202 Accepted with no body on success.
  // There is no provider message ID returned — use a synthetic one.
  // Increment daily send counter
  await supabase
    .from("email_providers")
    .update({ emails_sent_today: provider.emails_sent_today + 1 })
    .eq("id", provider.id);

  // Return a synthetic ID since Graph doesn't return one from sendMail.
  // If you need the real sent message ID, switch to POST /me/messages + POST /send.
  return `graph-sent-${Date.now()}`;
}

// ── Microsoft Graph token refresher ──────────────────────────────────────────
// Returns a valid access token, refreshing via Microsoft identity platform if needed.
async function getMicrosoftAccessToken(
  supabase: ReturnType<typeof createClient>,
  provider: ProviderRow
): Promise<string> {
  const now = new Date();
  const expiresAt = provider.token_expires_at
    ? new Date(provider.token_expires_at)
    : null;

  const encryptionKey = await getKey(Deno.env.get("TOKEN_ENCRYPTION_KEY")!);

  // Use cached token if still valid with 5 minute buffer
  if (
    provider.access_token_encrypted &&
    expiresAt &&
    expiresAt > new Date(now.getTime() + 5 * 60 * 1000)
  ) {
    return await decrypt(provider.access_token_encrypted as unknown as string, encryptionKey);
  }

  // Refresh the token
  const refreshToken = await decrypt(
    provider.refresh_token_encrypted as unknown as string,
    encryptionKey
  );

  const tokenResponse = await fetch(
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

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    await supabase
      .from("email_providers")
      .update({ status: "expired", error_message: `Token refresh failed: ${err}` })
      .eq("id", provider.id);
    throw new Error(`Microsoft token refresh failed: ${err}`);
  }

  const tokens = await tokenResponse.json();
  const newExpiry = new Date(now.getTime() + tokens.expires_in * 1000);

  await supabase
    .from("email_providers")
    .update({
      access_token_encrypted: await encrypt(tokens.access_token, encryptionKey),
      token_expires_at: newExpiry.toISOString(),
      status: "active",
      error_message: null,
    })
    .eq("id", provider.id);

  return tokens.access_token;
}

// ── Gmail Token Management ───────────────────
async function getGmailAccessToken(
  supabase: ReturnType<typeof createClient>,
  provider: ProviderRow
): Promise<string> {
  const now = new Date();
  const expiresAt = provider.token_expires_at
    ? new Date(provider.token_expires_at)
    : null;

  // If token is still valid with 5 minute buffer, use it
  const encryptionKey = await getKey(Deno.env.get("TOKEN_ENCRYPTION_KEY")!);

  if (
    provider.access_token_encrypted &&
    expiresAt &&
    expiresAt > new Date(now.getTime() + 5 * 60 * 1000)
  ) {
    return await decrypt(provider.access_token_encrypted as unknown as string, encryptionKey);
  }

  // Token expired or missing — refresh it
  const refreshToken = await decrypt(
    provider.refresh_token_encrypted as unknown as string,
    encryptionKey
  );

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    // Mark provider as expired so the org knows to re-authenticate
    await supabase
      .from("email_providers")
      .update({ status: "expired", error_message: `Token refresh failed: ${err}` })
      .eq("id", provider.id);
    throw new Error(`Token refresh failed: ${err}`);
  }

  const tokens = await tokenResponse.json();
  const newExpiry = new Date(now.getTime() + tokens.expires_in * 1000);

  // Store refreshed token
  await supabase
    .from("email_providers")
    .update({
      access_token_encrypted: await encrypt(tokens.access_token, encryptionKey),
      token_expires_at: newExpiry.toISOString(),
      status: "active",
      error_message: null,
    })
    .eq("id", provider.id);

  return tokens.access_token;
}

// ── Load Provider ────────────────────────────
async function loadProvider(
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
  providerType: "google" | "microsoft"
): Promise<ProviderRow> {
  const { data, error } = await supabase
    .from("email_providers")
    .select(
      "id, provider, provider_account_email, access_token_encrypted, " +
      "refresh_token_encrypted, token_expires_at, daily_send_limit, emails_sent_today"
    )
    .eq("organization_id", organizationId)
    .eq("provider", providerType)
    .eq("status", "active")
    .single<ProviderRow>();

  if (error || !data) {
    throw new Error(
      `No active ${providerType} provider found for org ${organizationId}`
    );
  }

  return data;
}

// ── Build RFC 2822 Email ─────────────────────
// Build a reply Subject that Gmail's client-side threading will match against
// the customer's original. Empty stays empty (matches customer's empty subject);
// an already-prefixed subject is preserved; anything else gets a single "Re: ".
function buildReplySubject(original: string | null): string {
  const s = (original ?? "").trim();
  if (s === "") return "";
  if (/^(re|fwd?):\s/i.test(s)) return s;
  return `Re: ${s}`;
}

function buildRfc2822Email(params: {
  from: string;
  to: string;
  subject: string;
  body: string;
  threadId: string;
  inReplyTo?: string;
}): string {
  const { from, to, subject, body, inReplyTo } = params;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: quoted-printable`,
  ];

  // Threading headers — tells Gmail and email clients this is a reply
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }

  return [...headers, "", body].join("\r\n");
}

// ── Job Failure Helpers ───────────────────────

// Hard fail — no more retries
async function failJob(
  supabase: ReturnType<typeof createClient>,
  job: QueueRow,
  reason: string
): Promise<void> {
  console.error(`Job ${job.id} permanently failed: ${reason}`);

  await supabase
    .from("delivery_queue")
    .update({
      status: "failed",
      error_message: reason,
      processing_started_at: null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  await supabase
    .from("messages")
    .update({ status: "sending_failed" })
    .eq("id", job.message_id);

  await supabase.from("analytics_events").insert({
    organization_id: job.organization_id,
    event_type: "delivery_failed",
    metadata: {
      queue_job_id: job.id,
      message_id: job.message_id,
      reason,
      final: true,
    },
  });
}

// Retry with exponential backoff, or hard fail if max attempts reached
async function retryOrFail(
  supabase: ReturnType<typeof createClient>,
  job: QueueRow,
  reason: string
): Promise<void> {
  const newAttemptCount = job.attempt_count + 1;
  const hasAttemptsLeft = newAttemptCount < job.max_attempts;

  if (!hasAttemptsLeft) {
    await failJob(supabase, job, `Max attempts reached. Last error: ${reason}`);
    return;
  }

  // Exponential backoff: 2min, 4min, 8min...
  const backoffMinutes = Math.pow(2, newAttemptCount);
  const nextAttempt = new Date(Date.now() + backoffMinutes * 60 * 1000);

  console.warn(
    `Job ${job.id} failed (attempt ${newAttemptCount}/${job.max_attempts}), ` +
    `retrying in ${backoffMinutes}min. Error: ${reason}`
  );

  await supabase
    .from("delivery_queue")
    .update({
      status: "pending",
      attempt_count: newAttemptCount,
      last_attempt_at: new Date().toISOString(),
      next_attempt_at: nextAttempt.toISOString(),
      error_message: reason,
      processing_started_at: null,
    })
    .eq("id", job.id);

  await supabase.from("analytics_events").insert({
    organization_id: job.organization_id,
    event_type: "delivery_failed",
    metadata: {
      queue_job_id: job.id,
      message_id: job.message_id,
      reason,
      attempt: newAttemptCount,
      retry_at: nextAttempt.toISOString(),
      final: false,
    },
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ESCALATION NOTIFICATION PROCESSING
// Widget-chat sets conversations.escalation_notify_at to NOW+10min on first
// escalation. This section picks up due notifications, fetches the full chat
// history at send time, and delivers one consolidated email per conversation.
// ══════════════════════════════════════════════════════════════════════════════

interface EscalationConversation {
  id: string;
  organization_id: string;
  customer_email: string | null;
  subject: string | null;
  escalation_type: string | null;
  lead_priority: string | null;
}

async function processEscalationNotifications(
  supabase: ReturnType<typeof createClient>
): Promise<{ sent: number }> {
  let sent = 0;

  try {
    // Find webchat conversations with due escalation notifications
    const { data: conversations, error } = await supabase
      .from("conversations")
      .select("id, organization_id, customer_email, subject, escalation_type, lead_priority")
      .not("escalation_notify_at", "is", null)
      .lte("escalation_notify_at", new Date().toISOString())
      .limit(10)
      .returns<EscalationConversation[]>();

    if (error || !conversations || conversations.length === 0) {
      return { sent };
    }

    for (const convo of conversations) {
      try {
        // Fetch full chat history at this moment (not at escalation time)
        const { data: messages } = await supabase
          .from("messages")
          .select("role, content, created_at")
          .eq("conversation_id", convo.id)
          .order("created_at", { ascending: true });

        const history = (messages ?? []) as Array<{ role: string; content: string; created_at: string }>;

        const escalationType = (convo.escalation_type ?? "frustrated") as "frustrated" | "kb_gap" | "lead";
        const leadPriority = convo.lead_priority as "high" | "mid" | "low" | null;

        const historyText = history.map((m) => {
          const role = m.role === "customer"
            ? `Customer (${convo.customer_email ?? "webchat visitor"})`
            : "AI Receptionist";
          const time = new Date(m.created_at).toLocaleString("en-US", { timeZone: "UTC" });
          return `[${time} UTC] ${role}:\n${m.content}`;
        }).join("\n\n---\n\n");

        const { emailSubject, body } = buildEscalationEmail({
          escalationType,
          leadPriority,
          customerEmail: convo.customer_email ?? "webchat visitor",
          subject: convo.subject,
          conversationId: convo.id,
          historyText,
        });

        await sendOrgNotification(supabase, convo.organization_id, "escalation", emailSubject, body, escalationType);

        // Clear the flag so we don't send again
        await supabase
          .from("conversations")
          .update({ escalation_notify_at: null })
          .eq("id", convo.id);

        sent++;
        console.log(`Escalation notification sent for conversation ${convo.id} (${escalationType})`);
      } catch (convError) {
        console.error(`Failed to send escalation notification for ${convo.id}:`, (convError as Error).message);
        // Don't clear the flag — will retry on next cron run
      }
    }
  } catch (err) {
    console.error("processEscalationNotifications error:", (err as Error).message);
  }

  return { sent };
}

// ── Escalation Email Templates ──────────────────────────────────────────────

function buildEscalationEmail(params: {
  escalationType: "frustrated" | "kb_gap" | "lead";
  leadPriority: "high" | "mid" | "low" | null;
  customerEmail: string;
  subject: string | null;
  conversationId: string;
  historyText: string;
}): { emailSubject: string; body: string } {
  const { escalationType, leadPriority, customerEmail, subject, conversationId, historyText } = params;

  const historyBlock = [
    ``,
    `─────────────────────────────────────`,
    `FULL MESSAGE HISTORY`,
    `─────────────────────────────────────`,
    ``,
    historyText,
  ].join("\n");

  if (escalationType === "kb_gap") {
    return {
      emailSubject: `📋 Knowledge Gap: ${subject ?? customerEmail}`,
      body: [
        `📋 KNOWLEDGE GAP — AI Could Not Answer`,
        ``,
        `The AI receptionist encountered a question it couldn't answer`,
        `using the available knowledge base.`,
        ``,
        `Customer: ${customerEmail}`,
        `Subject: ${subject ?? "(no subject)"}`,
        `Conversation ID: ${conversationId}`,
        ``,
        `Consider adding this information to your knowledge base`,
        `to improve future responses.`,
        historyBlock,
      ].join("\n"),
    };
  }

  if (escalationType === "lead") {
    const priorityLabel = leadPriority ? leadPriority.toUpperCase() : "UNRATED";
    return {
      emailSubject: `🎯 New Lead [${priorityLabel}]: ${subject ?? customerEmail}`,
      body: [
        `🎯 NEW LEAD CAPTURED`,
        ``,
        `A potential lead has been identified in a conversation.`,
        ``,
        `Customer: ${customerEmail}`,
        `Subject: ${subject ?? "(no subject)"}`,
        `Conversation ID: ${conversationId}`,
        `Priority: ${priorityLabel}`,
        ``,
        `The AI receptionist has engaged with the customer and collected`,
        `their information. Follow up to convert this lead.`,
        historyBlock,
      ].join("\n"),
    };
  }

  // Default: frustrated / legal
  return {
    emailSubject: `⚠️ Escalation Alert: ${subject ?? customerEmail}`,
    body: [
      `⚠️ ESCALATION ALERT`,
      ``,
      `A conversation has been flagged for immediate attention.`,
      `The customer may be frustrated or has raised a legal concern.`,
      ``,
      `Customer: ${customerEmail}`,
      `Subject: ${subject ?? "(no subject)"}`,
      `Conversation ID: ${conversationId}`,
      ``,
      `The AI receptionist has replied to the customer acknowledging the escalation,`,
      `but this conversation requires your personal attention urgently.`,
      historyBlock,
    ].join("\n"),
  };
}

// ── Org Notification Sender ─────────────────────────────────────────────────
// Sends internal notification emails to configured recipients or the business inbox.

async function sendOrgNotification(
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
  eventType: "escalation" | "usage_limit" | "system",
  subject: string,
  body: string,
  escalationSubType?: "frustrated" | "kb_gap" | "lead"
): Promise<void> {
  const { data: provider } = await supabase
    .from("email_providers")
    .select("id, provider, provider_account_email, access_token_encrypted, refresh_token_encrypted, token_expires_at")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .maybeSingle();

  if (!provider) {
    console.warn(`No active provider for org ${organizationId} — cannot send ${eventType} notification`);
    return;
  }

  let recipientQuery = supabase
    .from("notification_recipients")
    .select("email, name")
    .eq("organization_id", organizationId)
    .eq("is_active", true);

  if (eventType === "escalation" && escalationSubType) {
    // Match recipients with the specific sub-type OR legacy "escalation" (all escalations)
    recipientQuery = recipientQuery.overlaps("notify_on", [`escalation:${escalationSubType}`, "escalation"]);
  } else {
    recipientQuery = recipientQuery.contains("notify_on", [eventType]);
  }

  const { data: recipients } = await recipientQuery;

  const toAddresses: string[] = (recipients && recipients.length > 0)
    ? recipients.map((r: { email: string; name: string | null }) => r.name ? `${r.name} <${r.email}>` : r.email)
    : [provider.provider_account_email];

  // Get a valid access token using the existing provider token management
  let accessToken: string;
  if (provider.provider === "google") {
    const fullProvider = await loadProvider(supabase, organizationId, "google");
    accessToken = await getGmailAccessToken(supabase, fullProvider);
  } else if (provider.provider === "microsoft") {
    const fullProvider = await loadProvider(supabase, organizationId, "microsoft");
    accessToken = await getMicrosoftAccessToken(supabase, fullProvider);
  } else {
    console.warn(`Unsupported provider '${provider.provider}' for org notification`);
    return;
  }

  for (const toAddress of toAddresses) {
    try {
      if (provider.provider === "google") {
        const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
        const rawEmail = [
          `From: ${provider.provider_account_email}`,
          `To: ${toAddress}`,
          `Subject: ${encodedSubject}`,
          `MIME-Version: 1.0`,
          `Content-Type: text/plain; charset=utf-8`,
          ``,
          body,
        ].join("\r\n");

        const encodedEmail = btoa(unescape(encodeURIComponent(rawEmail)))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

        const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw: encodedEmail }),
        });

        if (!res.ok) {
          const err = await res.text();
          console.error(`Failed to send ${eventType} notification to ${toAddress}:`, err);
        } else {
          console.log(`${eventType} notification sent to ${toAddress} via Gmail`);
        }
      } else if (provider.provider === "microsoft") {
        const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              subject,
              body: { contentType: "Text", content: body },
              toRecipients: [{ emailAddress: { address: toAddress.replace(/.*<(.+)>/, "$1") } }],
            },
            saveToSentItems: false,
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          console.error(`Failed to send ${eventType} notification to ${toAddress}:`, err);
        } else {
          console.log(`${eventType} notification sent to ${toAddress} via Microsoft`);
        }
      }
    } catch (e) {
      console.error(`Failed to send ${eventType} notification to ${toAddress}:`, (e as Error).message);
    }
  }
}