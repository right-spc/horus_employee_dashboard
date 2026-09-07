// ============================================
// EDGE FUNCTION: handle-inbound-email
// Receives inbound email webhooks, assembles
// context, calls Kimi, routes the response.
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ── Types ────────────────────────────────────
interface InboundEmailPayload {
  provider: "google" | "microsoft";
  organization_id: string;
  sender_email: string;
  sender_name?: string;
  subject: string;
  body_text: string;       // Plain text version
  body_html?: string;
  thread_id: string;       // Gmail threadId / Outlook conversationId
  message_id: string;      // Gmail Message-ID for dedup
  received_at: string;     // ISO timestamp
}

interface RouteParseResult {
  code: "IGNORE" | "ESCALATE" | "DRAFT";
  confidence: number | null; // null if IGNORE or ESCALATE
  subject: string | null;    // From Claude, for data analysis purposes
  response_text: string;     // Everything after the first line
  escalation_type: "frustrated" | "kb_gap" | "lead" | null;
  lead_priority: "high" | "mid" | "low" | null;
}

// ── Constants ────────────────────────────────
const CONVERSATION_WINDOW = 50;    // Max messages to load from history
const SUMMARY_THRESHOLD = 100;     // Summarize after this many messages
const RECENT_MESSAGES_KEEP = 20;   // Keep this many recent messages in full
const INACTIVE_DAYS_THRESHOLD = 30; // Flag old convos in prompt
const DEFAULT_AUTO_SEND_THRESHOLD = 0.75;
const MONTHLY_PLAN_DAYS = 30;          // Duration of a monthly subscription period

// ── Kimi (Telnyx Inference) ──────────────────
// OpenAI-compatible chat completions. Whole KB is injected into the system
// prompt — K2.6's 256K context + Telnyx prompt caching make a retrieval
// pre-filter unnecessary (biggest KB in the system is ~34KB chars).
const KIMI_ENDPOINT = "https://api.telnyx.com/v2/ai/chat/completions";
const KIMI_MODEL = "moonshotai/Kimi-K2.6";
const REASONING_EFFORT = "low";  // keeps routing judgment without max latency
const KB_MAX_CHARS = 600_000;    // ~150K tokens — safety cap for whole-KB injection
// Telnyx rates per token (2026-09): input $0.665/M, cached input $0.08/M, output $4.00/M
const KIMI_COST_INPUT = 0.665 / 1_000_000;
const KIMI_COST_CACHED_INPUT = 0.08 / 1_000_000;
const KIMI_COST_OUTPUT = 4.0 / 1_000_000;

// ── Main Handler ─────────────────────────────
Deno.serve(async (req: Request) => {
  // Only accept POST
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Handle Microsoft Graph subscription validation challenge.
  // When creating a subscription, Microsoft POSTs to the notification URL with
  // ?validationToken=... and expects a 200 text/plain response echoing the token.
  const reqUrl = new URL(req.url);
  const validationToken = reqUrl.searchParams.get("validationToken");
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Initialize clients
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── 1. DETECT REQUEST TYPE ─────────────────
  // Two possible callers:
  // A) Google Pub/Sub push notification (inbound email alert)
  // B) Direct internal call with a fully structured InboundEmailPayload
  //    (useful for testing without going through Pub/Sub)
  const body = await req.json();
  const isPubSub = body?.message?.data !== undefined;

  let payloads: InboundEmailPayload[] = [];

  if (isPubSub) {
    // ── A) Pub/Sub path: decode notification and fetch real emails from Gmail
    try {
      payloads = await resolvePubSubNotification(body, supabase);
    } catch (e) {
      console.error("Failed to resolve Pub/Sub notification:", e.message);
      // Always return 200 to Pub/Sub — non-200 causes it to retry indefinitely
      return new Response("ok", { status: 200 });
    }

    if (payloads.length === 0) {
      // Nothing new to process (e.g. sent mail notification, history already seen)
      return new Response("ok", { status: 200 });
    }
  } else {
    // ── B) Direct call path: validate as before
    try {
      assertValidPayload(body);
      payloads = [body as InboundEmailPayload];
    } catch (e) {
      return new Response(`Bad request: ${e.message}`, { status: 400 });
    }
  }

  // Process each resolved email through the existing pipeline
  const results = [];
  for (const payload of payloads) {
    try {
      results.push(await processInboundEmail(payload, supabase));
    } catch (e) {
      console.error(`Failed to process email for ${payload.sender_email}:`, e.message);
      results.push({ error: e.message });
    }
  }

  return new Response(JSON.stringify({ results }), { status: 200 });
});

// ── Pipeline: process one fully-resolved inbound email ───────────────────────
// This is the existing logic unchanged — it now receives a payload that has
// already been fetched and structured from the Gmail API.
async function processInboundEmail(
  payload: InboundEmailPayload,
  supabase: ReturnType<typeof createClient>
): Promise<Record<string, unknown>> {

  // ── 2. LOAD ORGANIZATION CONFIG ────────────
  console.log("Looking up org ID:", payload.organization_id);
  const { data: org, error: orgError } = await supabase // TEMP
    .schema("core").from("organizations")
    .select(`
      id,
      ai_responses_enabled,
      subscription_end_date,
      ai_tone,
      auto_send_enabled,
      auto_send_min_confidence,
      ai_system_prompt,
      ai_system_prompt_version,
      business_hours_timezone,
      business_profiles (
        business_name,
        description,
        address,
        city,
        state,
        phone,
        website_url,
        booking_url,
        booking_instructions,
        cancellation_policy,
        deposit_policy,
        other_policies,
        email_signature
      ),
      business_hours (
        day_of_week,
        is_open,
        open_time,
        close_time,
        note
      ),
      business_services (
        name,
        description,
        category,
        price_type,
        price_min_cents,
        price_max_cents,
        duration_minutes,
        is_active
      )
    `)
    .eq("id", payload.organization_id)
    .single();

  if (orgError || !org) {
    console.log("Org query error:", orgError); // TEMP
    console.log("Org data:", org ? "found" : "null"); // TEMP
    throw new Error(`Organization not found: ${payload.organization_id}`);
  }

  const autoSendThreshold =
    org.auto_send_min_confidence ?? DEFAULT_AUTO_SEND_THRESHOLD;

  // ── CHECK AI RESPONSES ENABLED ────────────
  if (!org.ai_responses_enabled) {
    const { data: disabledConv } = await supabase
      .schema("messaging").from("conversations")
      .upsert(
        {
          organization_id: payload.organization_id,
          channel: "email",
          external_thread_id: payload.thread_id,
          customer_email: payload.sender_email.toLowerCase().trim(),
          subject: payload.subject,
          status: "active",
          ai_enabled: false,
        },
        { onConflict: "organization_id,channel,external_thread_id", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (disabledConv?.id) {
      await saveCustomerMessage(supabase, {
        conversation_id: disabledConv.id,
        organization_id: payload.organization_id,
        content: payload.body_text,
        external_message_id: payload.message_id,
      });
    }
    console.log(`Org ${payload.organization_id} has AI responses disabled — skipping Claude`);
    return { status: "skipped", reason: "ai_responses_disabled" };
  }

  // ── CHECK SUBSCRIPTION EXPIRY ─────────────
  // Allow a 7-day grace period after subscription_end_date before blocking
  // AI responses. cron-maintenance sends a warning email and eventually
  // flips ai_responses_enabled + widget_configs.enabled as backup enforcement.
  if (org.subscription_end_date) {
    const now = new Date();
    const endDate = new Date(org.subscription_end_date);
    const graceDeadline = new Date(endDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    if (now > graceDeadline) {
      const { data: expiredConv } = await supabase
        .schema("messaging").from("conversations")
        .upsert(
          {
            organization_id: payload.organization_id,
            channel: "email",
            external_thread_id: payload.thread_id,
            customer_email: payload.sender_email.toLowerCase().trim(),
            subject: payload.subject,
            status: "active",
            ai_enabled: false,
          },
          { onConflict: "organization_id,channel,external_thread_id", ignoreDuplicates: false }
        )
        .select("id")
        .single();

      if (expiredConv?.id) {
        await saveCustomerMessage(supabase, {
          conversation_id: expiredConv.id,
          organization_id: payload.organization_id,
          content: payload.body_text,
          external_message_id: payload.message_id,
        });
      }
      console.log(`Org ${payload.organization_id} subscription expired — skipping AI`);
      return { status: "skipped", reason: "subscription_expired" };
    }
  }

  // ── CHECK MONTHLY USAGE LIMIT ─────────────
  // Check before calling Claude — if over limit, save the message
  // but skip AI processing and return early.
  const isOverLimit = await checkUsageLimit(supabase, payload.organization_id);
  if (isOverLimit) {
    // Still save the inbound message so it's not lost
    const { data: limitConv } = await supabase
      .schema("messaging").from("conversations")
      .upsert(
        {
          organization_id: payload.organization_id,
          channel: "email",
          external_thread_id: payload.thread_id,
          customer_email: payload.sender_email.toLowerCase().trim(),
          subject: payload.subject,
          status: "active",
          ai_enabled: false, // Disable AI for this conversation until limit resets
        },
        { onConflict: "organization_id,channel,external_thread_id", ignoreDuplicates: true }
      )
      .select("id")
      .single();
    if (limitConv?.id) {
      await saveCustomerMessage(supabase, {
        conversation_id: limitConv.id,
        organization_id: payload.organization_id,
        content: payload.body_text,
        external_message_id: payload.message_id,
      });
    }
    console.log(`Org ${payload.organization_id} over monthly limit — skipping AI`);
    return { status: "skipped", reason: "usage_limit_exceeded" };
  }

  // ── 3. IDENTITY RESOLUTION ─────────────────
  // Look up sender by email alias
  const { data: alias } = await supabase
    .schema("crm").from("contact_aliases")
    .select("contact_id")
    .eq("organization_id", payload.organization_id)
    .eq("alias_type", "email")
    .eq("alias_hash", payload.sender_email.toLowerCase().trim())
    .maybeSingle();

  let contactId: string;

  if (alias) {
    contactId = alias.contact_id;
    // Update last_seen_at
    await supabase
      .schema("crm").from("contacts")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", contactId);
  } else {
    // Create new contact
    const { data: newContact, error: contactError } = await supabase
      .schema("crm").from("contacts")
      .insert({
        organization_id: payload.organization_id,
        primary_email: payload.sender_email.toLowerCase().trim(),
        name: payload.sender_name ?? null,
      })
      .select("id")
      .single();

    if (contactError || !newContact) {
      throw new Error(`Failed to create contact: ${contactError?.message}`);
    }

    contactId = newContact.id;

    // Create alias record
    await supabase.schema("crm").from("contact_aliases").insert({
      contact_id: contactId,
      organization_id: payload.organization_id,
      alias_type: "email",
      alias_value: payload.sender_email.toLowerCase().trim(),
      source: "email_header",
    });
  }

  // ── 4. CONVERSATION RESOLUTION ─────────────
  // Upsert conversation by thread ID (unique per org+channel+thread)
  const { data: conversation, error: convError } = await supabase
    .schema("messaging").from("conversations")
    .upsert(
      {
        organization_id: payload.organization_id,
        contact_id: contactId,
        channel: "email",
        external_thread_id: payload.thread_id,
        customer_email: payload.sender_email.toLowerCase().trim(),
        subject: payload.subject,
        status: "active",
        ai_enabled: true,
      },
      {
        onConflict: "organization_id,channel,external_thread_id",
        ignoreDuplicates: false,
      }
    )
    .select("id, status, last_message_at, ai_enabled, summary, summary_msg_count")
    .single();

  if (convError || !conversation) {
    throw new Error(`Failed to upsert conversation: ${convError?.message}`);
  }

  // If conversation is escalated or AI is disabled, save message and exit
  if (conversation.status === "escalated" || !conversation.ai_enabled) {
    await saveCustomerMessage(supabase, {
      conversation_id: conversation.id,
      organization_id: payload.organization_id,
      content: payload.body_text,
      external_message_id: payload.message_id,
    });
    return { status: "skipped", reason: conversation.status };
  }

  // ── 5. SAVE INBOUND MESSAGE ────────────────
  // Always save BEFORE calling Claude — if Claude fails, message is not lost.
  // Idempotency: Pub/Sub is at-least-once and Gmail can fire duplicate
  // historyId notifications, so the same external_message_id may arrive
  // multiple times. Short-circuit if we've already processed it.
  const { data: existingMessage } = await supabase
    .schema("messaging").from("messages")
    .select("id")
    .eq("organization_id", payload.organization_id)
    .eq("external_message_id", payload.message_id)
    .eq("role", "customer")
    .maybeSingle();

  if (existingMessage) {
    console.log(`Duplicate notification for message ${payload.message_id} — already processed, skipping`);
    return { status: "skipped", reason: "duplicate" };
  }

  const { data: inboundMessage, error: msgError } = await supabase
    .schema("messaging").from("messages")
    .insert({
      conversation_id: conversation.id,
      organization_id: payload.organization_id,
      role: "customer",
      content: payload.body_text,
      status: "sent",
      external_message_id: payload.message_id,
    })
    .select("id")
    .single();

  if (msgError || !inboundMessage) {
    throw new Error(`Failed to save inbound message: ${msgError?.message}`);
  }

  // ── 6. LOG ANALYTICS EVENT ─────────────────
  await supabase.schema("analytics").from("analytics_events").insert({
    organization_id: payload.organization_id,
    event_type: "message_received",
    metadata: {
      conversation_id: conversation.id,
      channel: "email",
      provider: payload.provider,
    },
  });

  // ── 7. CONTEXT ASSEMBLY ────────────────────

  // 7a. Conversation history — count total then decide: full window or summary + recent
  const { count: totalMsgCount } = await supabase
    .schema("messaging").from("messages")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conversation.id)
    .in("status", ["sent", "auto_sent"]);

  let history: Array<{ role: string; content: string; created_at: string }>;
  let conversationSummary: string | null = null;

  if ((totalMsgCount ?? 0) > SUMMARY_THRESHOLD) {
    // Summarize older messages, keep only recent ones in full
    conversationSummary = await getOrUpdateSummary(
      supabase, conversation.id,
      totalMsgCount ?? 0, conversation.summary, conversation.summary_msg_count ?? 0,
      ["sent", "auto_sent"]
    );

    const { data: recentMessages } = await supabase
      .schema("messaging").from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversation.id)
      .in("status", ["sent", "auto_sent"])
      .order("created_at", { ascending: false })
      .limit(RECENT_MESSAGES_KEEP);

    history = (recentMessages ?? []).reverse();
  } else {
    const { data: historyMessages } = await supabase
      .schema("messaging").from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversation.id)
      .in("status", ["sent", "auto_sent"])
      .order("created_at", { ascending: false })
      .limit(CONVERSATION_WINDOW);

    history = (historyMessages ?? []).reverse();
  }

  // 7b. Load the org's full knowledge base (injected wholesale into the
  // system prompt — see KIMI constants above)
  const kbChunks = await loadAllKbChunks(supabase, payload.organization_id);

  // 7c. Check if conversation is stale (affects prompt instruction)
  const lastMessageAt = new Date(conversation.last_message_at);
  const daysSinceLastMessage = Math.floor(
    (Date.now() - lastMessageAt.getTime()) / (1000 * 60 * 60 * 24)
  );
  const isStaleConversation = daysSinceLastMessage >= INACTIVE_DAYS_THRESHOLD;

  // ── 8. BUILD SYSTEM PROMPT ─────────────────
  // Check for active Calendly integration and Google Calendar access
  const calendlyIntegration = await loadCalendlyIntegration(supabase, payload.organization_id);
  const googleCalendarProvider = calendlyIntegration
    ? await loadGoogleCalendarProvider(supabase, payload.organization_id)
    : null;

  const businessTimezone = (org.business_hours_timezone as string) || "UTC";

  let systemPrompt = buildSystemPrompt({
    org,
    kbChunks: kbChunks ?? [],
    isStaleConversation,
    daysSinceLastMessage,
    calendlyConnected: !!calendlyIntegration,
    googleCalendarAvailable: !!googleCalendarProvider,
    customerTimezone: businessTimezone,
  });

  if (conversationSummary) {
    systemPrompt += `\n\n## Conversation Summary (earlier messages)\n${conversationSummary}`;
  }

  // ── 9. BUILD MESSAGES ARRAY ────────────────
  const kimiMessages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({
      role: m.role === "customer" ? "user" : "assistant",
      content: m.content,
    })),
    // The new inbound message
    {
      role: "user",
      content: payload.body_text,
    },
  ];

  // ── 10. CALL KIMI ──────────────────────────
  const startTime = Date.now();
  console.log("Calling Kimi API...");
  const toolsArr: any[] = [SUBMIT_RESPONSE_TOOL];
  if (calendlyIntegration) {
    toolsArr.push(...CALENDLY_TOOLS);
    if (googleCalendarProvider) toolsArr.push(BOOK_APPOINTMENT_TOOL);
  }

  let kimiResponse = await callKimiWithRetry({
    model: KIMI_MODEL,
    max_tokens: 2000,
    reasoning_effort: REASONING_EFFORT,
    messages: kimiMessages,
    tools: toolsArr,
    tool_choice: "required",
  });

  // Handle tool use loop (max 3 iterations)
  let totalInputTokens = kimiResponse.usage?.prompt_tokens ?? 0;
  let totalCachedTokens = kimiResponse.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  let totalOutputTokens = kimiResponse.usage?.completion_tokens ?? 0;
  let toolUseIterations = 0;
  let submitResponseData: Record<string, unknown> | null = null;

  while (
    kimiResponse.choices?.[0]?.finish_reason === "tool_calls" &&
    toolUseIterations < 3
  ) {
    toolUseIterations++;
    const assistantMsg = kimiResponse.choices[0].message;
    const toolCalls = (assistantMsg.tool_calls ?? []) as any[];

    console.log(`Tool use iteration ${toolUseIterations}, tools called:`, toolCalls.map((t: any) => t.function?.name));

    // Check if submit_response was called — that's the final response
    const submitCall = toolCalls.find((t: any) => t.function?.name === "submit_response");
    if (submitCall) {
      submitResponseData = parseToolArguments(submitCall.function?.arguments);
    }

    // Execute other tools (not submit_response)
    const toolResultMessages: any[] = [];
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function?.name as string;
      const toolInput = parseToolArguments(toolCall.function?.arguments);
      if (toolName === "submit_response") {
        toolResultMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ received: true }),
        });
        continue;
      }
      let result;
      if (toolName === "book_appointment" && googleCalendarProvider) {
        const profile = (org.business_profiles as Record<string, unknown>[])?.[0];
        const bName = (profile?.business_name as string) || "the business";
        result = await executeBookingTool(
          supabase, googleCalendarProvider, toolInput,
          businessTimezone, bName
        );
      } else if (calendlyIntegration) {
        result = await executeCalendlyTool(
          supabase, calendlyIntegration, toolName, toolInput,
          businessTimezone
        );
      } else {
        result = { error: true, message: "Unknown tool" };
      }
      toolResultMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    // If submit_response was called, we're done
    if (submitResponseData) break;

    kimiMessages.push({
      role: "assistant",
      content: assistantMsg.content ?? "",
      tool_calls: assistantMsg.tool_calls,
    });
    kimiMessages.push(...toolResultMessages);

    kimiResponse = await callKimiWithRetry({
      model: KIMI_MODEL,
      max_tokens: 2000,
      reasoning_effort: REASONING_EFFORT,
      messages: kimiMessages,
      tools: toolsArr,
      tool_choice: "required",
    });

    totalInputTokens += kimiResponse.usage?.prompt_tokens ?? 0;
    totalCachedTokens += kimiResponse.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    totalOutputTokens += kimiResponse.usage?.completion_tokens ?? 0;
  }

  const processingTimeMs = Date.now() - startTime;

  const rawResponseText = (kimiResponse.choices?.[0]?.message?.content as string) ?? "";
  console.log("Kimi API responded, raw:", rawResponseText.slice(0, 100));

  const tokensUsed = totalInputTokens + totalOutputTokens;

  const costEstimate =
    (totalInputTokens - totalCachedTokens) * KIMI_COST_INPUT +
    totalCachedTokens * KIMI_COST_CACHED_INPUT +
    totalOutputTokens * KIMI_COST_OUTPUT;

  // ── 11. PARSE ROUTING CODE ─────────────────
  let parsed: RouteParseResult;

  if (submitResponseData) {
    parsed = parseSubmitResponse(submitResponseData);
  } else {
    // Fallback: parse text the old way
    parsed = parseClaudeResponse(rawResponseText);
    if (toolUseIterations > 0 && parsed.confidence === 0.0) {
      parsed.confidence = 0.85;
    }
  }

  // If response text is empty, provide a fallback
  if (!parsed.response_text?.trim()) {
    parsed.response_text = "Thank you for your message. Let me look into this and get back to you shortly.";
    parsed.confidence = 0.50;
  }

  // Append business email signature (Claude is instructed not to write its own)
  const emailSignature =
    (org.business_profiles as Record<string, unknown>[])?.[0]?.email_signature as
      | string
      | null
      | undefined;
  if (emailSignature && parsed.response_text && parsed.code !== "IGNORE") {
    parsed.response_text = `${parsed.response_text}\n\n${emailSignature}`;
  }

  // ── 12. ROUTE ──────────────────────────────
  if (parsed.code === "IGNORE") {
    // Save the AI decision but do nothing else — email stays unread
    const { error: ignoreInsertError } = await supabase.schema("messaging").from("messages").insert({
      conversation_id: conversation.id,
      organization_id: payload.organization_id,
      role: "ai",
      content: rawResponseText,
      status: "rejected",
      routing_code: "IGNORE",
      confidence_score_reported: null,
      ai_model: KIMI_MODEL,
      ai_prompt_version: org.ai_system_prompt_version,
      processing_time_ms: processingTimeMs,
      tokens_used: tokensUsed,
      cost_estimate: costEstimate,
    });
    console.log("IGNORE insert error:", ignoreInsertError);

    await supabase.schema("analytics").from("analytics_events").insert({
      organization_id: payload.organization_id,
      event_type: "ai_generated",
      metadata: {
        conversation_id: conversation.id,
        routing_code: "IGNORE",
      },
    });

    return { status: "ignored" };
  }

  if (parsed.code === "ESCALATE") {
    // Save message
    const { data: escalateMessage, error: escalateMsgError } = await supabase
      .schema("messaging").from("messages")
      .insert({
        conversation_id: conversation.id,
        organization_id: payload.organization_id,
        role: "ai",
        content: parsed.response_text,
        status: "auto_sent",
        routing_code: "ESCALATE",
        confidence_score_reported: null,
        ai_model: KIMI_MODEL,
        ai_prompt_version: org.ai_system_prompt_version,
        processing_time_ms: processingTimeMs,
        tokens_used: tokensUsed,
        cost_estimate: costEstimate,
        review_reason: "escalated_by_ai",
        escalation_type: parsed.escalation_type,
        lead_priority: parsed.lead_priority,
      })
      .select("id")
      .single();

    if (escalateMsgError || !escalateMessage) {
      throw new Error(`Failed to save escalation message: ${escalateMsgError?.message}`);
    }

    // Flip conversation to escalated
    await supabase
      .schema("messaging").from("conversations")
      .update({
        status: "escalated",
        escalation_reason: "AI determined human intervention required",
        escalation_type: parsed.escalation_type,
        lead_priority: parsed.lead_priority,
      })
      .eq("id", conversation.id);

    await supabase.schema("analytics").from("analytics_events").insert({
      organization_id: payload.organization_id,
      event_type: "escalated",
      metadata: {
        conversation_id: conversation.id,
        escalation_type: parsed.escalation_type,
        lead_priority: parsed.lead_priority,
      },
    });

    // Queue Claude's response for delivery to customer
    const escalateProvider = await supabase
      .schema("comms").from("email_providers")
      .select("id, provider")
      .eq("organization_id", payload.organization_id)
      .eq("status", "active")
      .maybeSingle();

    if (escalateProvider.data) {
      await supabase.schema("messaging").from("delivery_queue").insert({
        message_id: escalateMessage.id,
        organization_id: payload.organization_id,
        provider: escalateProvider.data.provider,
        status: "pending",
        next_attempt_at: new Date().toISOString(),
      });
    }

    // Send internal notification email to business inbox
    await sendEscalationNotification(supabase, {
      organizationId: payload.organization_id,
      conversationId: conversation.id,
      customerEmail: payload.sender_email,
      subject: parsed.subject ?? payload.subject,
      history,
      aiResponse: parsed.response_text,
      escalationType: parsed.escalation_type ?? "frustrated",
      leadPriority: parsed.lead_priority,
    });

    // Update last_ai_response_at
    await supabase
      .schema("messaging").from("conversations")
      .update({ last_ai_response_at: new Date().toISOString() })
      .eq("id", conversation.id);

    // Increment monthly usage counter (1 exchange = inbound + AI reply)
    const justExceededEscalate = await incrementUsage(supabase, payload.organization_id);
    if (justExceededEscalate) {
      // Fire and forget — don't delay the response
      handleLimitExceeded(supabase, payload.organization_id).catch((e) =>
        console.error("handleLimitExceeded error:", e.message)
      );
    }

    return { status: "escalated", conversation_id: conversation.id };
  }

  // ── DRAFT path ─────────────────────────────
  const confidence = parsed.confidence ?? 0;
  const shouldAutoSend =
    org.auto_send_enabled && confidence >= autoSendThreshold;

  const messageStatus = shouldAutoSend ? "auto_sent" : "pending_review";
  const reviewReason = !shouldAutoSend
    ? confidence === 0
      ? "low_confidence"
      : `confidence_${confidence}_below_threshold_${autoSendThreshold}`
    : null;

  // Save the AI draft
  const { data: aiMessage, error: aiMsgError } = await supabase
    .schema("messaging").from("messages")
    .insert({
      conversation_id: conversation.id,
      organization_id: payload.organization_id,
      role: "ai",
      content: parsed.response_text,
      status: messageStatus,
      routing_code: "DRAFT",
      external_message_id: payload.message_id,
      confidence_score_reported: confidence,
      ai_model: KIMI_MODEL,
      ai_prompt_version: org.ai_system_prompt_version,
      processing_time_ms: processingTimeMs,
      tokens_used: tokensUsed,
      cost_estimate: costEstimate,
      review_reason: reviewReason,
    })
    .select("id")
    .single();

  if (aiMsgError || !aiMessage) {
    throw new Error(`Failed to save AI message: ${aiMsgError?.message}`);
  }

  await supabase.schema("analytics").from("analytics_events").insert({
    organization_id: payload.organization_id,
    event_type: "ai_generated",
    metadata: {
      conversation_id: conversation.id,
      routing_code: "DRAFT",
      confidence,
      auto_send: shouldAutoSend,
    },
  });

  // Queue for delivery if auto-sending
  if (shouldAutoSend) {
    const emailProvider = await supabase
      .schema("comms").from("email_providers")
      .select("id, provider")
      .eq("organization_id", payload.organization_id)
      .eq("status", "active")
      .maybeSingle();

    if (emailProvider.data) {
      await supabase.schema("messaging").from("delivery_queue").insert({
        message_id: aiMessage.id,
        organization_id: payload.organization_id,
        provider: emailProvider.data.provider,
        status: "pending",
        next_attempt_at: new Date().toISOString(),
      });
    }
  }

  // Update last_ai_response_at on conversation
  await supabase
    .schema("messaging").from("conversations")
    .update({ last_ai_response_at: new Date().toISOString() })
    .eq("id", conversation.id);

  // NOTE: conversation.subject is intentionally NOT overwritten with parsed.subject.
  // For email channels it must stay equal to the original inbound Subject so that
  // process-delivery-queue can build "Re: <original>" — Gmail's messages.send API
  // rejects threadId binding if the reply Subject doesn't match the thread's,
  // which silently creates a new thread customer-side.

  // Increment monthly usage counter (1 exchange = inbound + AI reply)
  const justExceeded = await incrementUsage(supabase, payload.organization_id);
  if (justExceeded) {
    // Fire and forget — don't delay the response
    handleLimitExceeded(supabase, payload.organization_id).catch((e) =>
      console.error("handleLimitExceeded error:", e.message)
    );
  }

  return {
    status: shouldAutoSend ? "queued" : "pending_review",
    message_id: aiMessage.id,
    confidence,
  };
}

// ── Helper: Validate payload ─────────────────
function assertValidPayload(p: unknown): asserts p is InboundEmailPayload {
  const payload = p as Record<string, unknown>;
  const required = [
    "provider", "organization_id", "sender_email",
    "subject", "body_text", "thread_id", "message_id", "received_at",
  ];
  for (const field of required) {
    if (!payload[field]) throw new Error(`Missing required field: ${field}`);
  }
  if (!["google", "microsoft"].includes(payload.provider as string)) {
    throw new Error("Invalid provider");
  }
}

// ── Helper: Save customer message ────────────
async function saveCustomerMessage(
  supabase: ReturnType<typeof createClient>,
  params: {
    conversation_id: string;
    organization_id: string;
    content: string;
    external_message_id: string;
  }
) {
  return supabase.schema("messaging").from("messages").insert({
    ...params,
    role: "customer",
    status: "sent",
  });
}

// ── Helper: Load the org's entire knowledge base ──
// All chunks are injected into the system prompt (K2.6 256K context + Telnyx
// prompt caching make a retrieval pre-filter unnecessary). KB_MAX_CHARS is a
// safety valve for pathologically large knowledge bases.
async function loadAllKbChunks(
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
): Promise<Array<{ content: string }>> {
  const { data: allChunks } = await supabase
    .schema("kb").from("kb_chunks")
    .select("content")
    .eq("organization_id", organizationId)
    .order("chunk_index", { ascending: true });

  if (!allChunks || allChunks.length === 0) return [];

  let total = 0;
  const result: Array<{ content: string }> = [];
  for (const c of allChunks) {
    total += (c.content as string).length;
    if (total > KB_MAX_CHARS) {
      console.warn(`KB truncated at ${KB_MAX_CHARS} chars for org ${organizationId}`);
      result.push({ content: "[Note: knowledge base truncated due to size]" });
      break;
    }
    result.push({ content: c.content });
  }
  return result;
}

// ── Helper: Conversation summarization ──────────────
async function getOrUpdateSummary(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  totalCount: number,
  existingSummary: string | null,
  summaryMsgCount: number,
  statuses: string[]
): Promise<string | null> {
  const messagesToSummarize = totalCount - RECENT_MESSAGES_KEEP;

  // Summary is already up to date
  if (existingSummary && summaryMsgCount >= messagesToSummarize) {
    return existingSummary;
  }

  // Load messages that need summarizing (oldest N, excluding the recent ones we keep in full)
  const { data: msgs } = await supabase
    .schema("messaging").from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .in("status", statuses)
    .order("created_at", { ascending: true })
    .range(summaryMsgCount, messagesToSummarize - 1);

  if (!msgs || msgs.length === 0) return existingSummary;

  const newMsgText = msgs.map((m: { role: string; content: string }) =>
    `${m.role === "customer" ? "Customer" : "AI"}: ${m.content}`
  ).join("\n\n");

  const input = existingSummary
    ? `Existing summary:\n${existingSummary}\n\nNew messages to incorporate:\n${newMsgText}`
    : newMsgText;

  try {
    const response = await callKimiWithRetry({
      model: KIMI_MODEL,
      max_tokens: 800,
      reasoning_effort: REASONING_EFFORT,
      messages: [
        { role: "system", content: "Summarize this conversation concisely. You MUST preserve ALL specific details: full names, email addresses, phone numbers, dates, times, prices, appointment details, booking references, and any commitments made. Output only the summary paragraph." },
        { role: "user", content: input },
      ],
    });

    const summary = ((response.choices?.[0]?.message?.content as string) ?? "").trim();

    if (!summary) return existingSummary;

    await supabase
      .schema("messaging").from("conversations")
      .update({ summary, summary_msg_count: messagesToSummarize })
      .eq("id", conversationId);

    console.log(`Summarized ${messagesToSummarize} messages for conversation ${conversationId}`);
    return summary;
  } catch (e) {
    console.error("Summarization failed, falling back to full history:", e.message);
    return existingSummary;
  }
}

// ── Helper: Build system prompt ──────────────
function buildSystemPrompt(params: {
  org: Record<string, unknown>;
  kbChunks: Array<{ content: string }>;
  isStaleConversation: boolean;
  daysSinceLastMessage: number;
  calendlyConnected?: boolean;
  googleCalendarAvailable?: boolean;
  customerTimezone?: string;
}): string {
  const { org, kbChunks, isStaleConversation, daysSinceLastMessage, calendlyConnected, googleCalendarAvailable, customerTimezone } = params;
  const profile = (org.business_profiles as Record<string, unknown>[])?.[0];
  const hours = org.business_hours as Array<Record<string, unknown>>;
  const services = (org.business_services as Array<Record<string, unknown>>)
    ?.filter((s) => s.is_active);

  // Use org's custom prompt as base, or fall back to default template
  const basePrompt = (org.ai_system_prompt as string) ?? DEFAULT_SYSTEM_PROMPT;

  // Interpolate business data into prompt template.
  // Required fields always substituted. Optional fields: if null, the entire
  // line containing the placeholder is removed so Claude never sees blank labels.
  const businessName = (profile?.business_name as string) || "our business";
  const aiTone = (org.ai_tone as string) || "professional";

  let prompt = basePrompt
    .replace("{business_name}", businessName)
    .replace("{ai_tone}", aiTone);

  const optionalFields: Record<string, string | null> = {
    "{business_description}": (profile?.description as string) ?? null,
    "{booking_url}":           (profile?.booking_url as string) ?? null,
    "{booking_instructions}":  (profile?.booking_instructions as string) ?? null,
    "{cancellation_policy}":   (profile?.cancellation_policy as string) ?? null,
    "{deposit_policy}":        (profile?.deposit_policy as string) ?? null,
  };

  for (const [placeholder, value] of Object.entries(optionalFields)) {
    if (value) {
      prompt = prompt.replace(placeholder, value);
    } else {
      // Remove the entire line containing this placeholder — no blank labels in prompt
      prompt = prompt.replace(
        new RegExp(`[^\n]*\{${placeholder.slice(1, -1)}\}[^\n]*\n?`, "g"),
        ""
      );
    }
  }

  // Strip old text-based routing format instructions from custom prompts
  prompt = prompt.replace(/## IMPORTANT: Response Format[\s\S]*?Your actual reply to the (?:visitor|customer) follows on the next line\./g, "");
  prompt = prompt.replace(/Always start your response with exactly one of these routing codes[\s\S]*?Do not include any text before the routing code\./g, "");

  // Calendly-aware booking instructions (replaces "cannot see calendar" when connected)
  if (calendlyConnected) {
    prompt = prompt.replace(/[^\n]*cannot see calendar availability[^\n]*\n?/gi, "");
    prompt = prompt.replace(/[^\n]*Suggest specific calendar openings[^\n]*\n?/gi, "");
    const tzLabel = customerTimezone || "the business timezone";
    if (googleCalendarAvailable) {
      prompt += `\n\n## Calendar Integration (ACTIVE - Full Booking)
The customer's timezone is ${tzLabel}. All times from check_availability are already converted to this timezone — present them directly without any conversion.
When a customer asks about availability or wants to book:
1. Use the check_availability tool to look up real available times
2. Present the available times in a friendly, grouped-by-day format (offer 3-5 options)
3. When the customer picks a time, collect their full name and email address if you don't already have them
4. Use the book_appointment tool to create the booking — pass the start_time_iso value EXACTLY as received from check_availability. NEVER construct or modify datetime strings yourself.
5. After booking, confirm the details: date, time, service, and mention they'll receive a calendar invite at their email
You CAN see real calendar availability and book appointments directly. Do not tell customers you cannot check the calendar.`;
    } else {
      prompt += `\n\n## Calendar Integration (ACTIVE)
The customer's timezone is ${tzLabel}. All times from check_availability are already converted to this timezone — present them directly without any conversion.
When a customer asks about availability or wants to book:
1. Use the check_availability tool to look up real available times
2. Present the available times in a friendly, grouped-by-day format (offer 3-5 options)
3. Each time slot comes with a scheduling_url — when the customer picks a time, share that slot's scheduling_url directly (it takes them to the final booking step with the time pre-selected)
4. Do NOT wrap URLs in markdown formatting — paste the plain URL
You CAN see real calendar availability. Do not tell customers you cannot check the calendar.`;
    }
  }

  // Append business hours
  if (hours?.length) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const hoursText = hours
      .sort((a, b) => (a.day_of_week as number) - (b.day_of_week as number))
      .map((h) =>
        h.is_open
          ? `${dayNames[h.day_of_week as number]}: ${h.open_time} - ${h.close_time}${h.note ? ` (${h.note})` : ""}`
          : `${dayNames[h.day_of_week as number]}: Closed`
      )
      .join("\n");
    prompt += `\n\n## Business Hours\n${hoursText}`;
  }

  // Append services
  if (services?.length) {
    const servicesText = services
      .map((s) => {
        let price = "";
        if (s.price_type === "fixed") {
          price = `$${((s.price_min_cents as number) / 100).toFixed(2)}`;
        } else if (s.price_type === "range") {
          price = `$${((s.price_min_cents as number) / 100).toFixed(2)} - $${((s.price_max_cents as number) / 100).toFixed(2)}`;
        } else {
          price = "Call for quote";
        }
        const duration = s.duration_minutes ? ` | ${s.duration_minutes} min` : "";
        return `- ${s.name}: ${price}${duration}${s.description ? ` — ${s.description}` : ""}`;
      })
      .join("\n");
    prompt += `\n\n## Services\n${servicesText}`;
  }

  // Append KB chunks if found
  if (kbChunks.length > 0) {
    const kbText = kbChunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n");
    prompt += `\n\n## Knowledge Base\n${kbText}`;
  }

  // Routing rules (static per org — kept inside the cacheable prefix)
  const routingRules = (org.routing_rules as string) || DEFAULT_ROUTING_RULES;
  prompt += `\n\n## Routing Rules\n${routingRules}`;

  // Signature handling — a business-configured signature is appended in code
  // after your response. End with your last sentence of substance, no signoff.
  if (profile?.email_signature) {
    prompt += `\n\n## Signature\nA signature will be automatically appended to your response. ` +
      `Do NOT write any signoff, closing line, or signature yourself (no "Best regards", ` +
      `"Thanks", business name, disclaimer, etc.). End your response with the last sentence of substance.`;
  }

  // ── Dynamic tail: everything below varies per request and would break the
  // prompt-cache prefix, so it goes last ──

  // Current date so Kimi knows what "today" and "tomorrow" mean
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const dayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getUTCDay()];
  prompt += `\n\n## Current Date\nToday is ${dayName}, ${dateStr} (UTC).`;

  // Stale conversation warning
  if (isStaleConversation) {
    prompt += `\n\n## Note\nThis conversation was last active ${daysSinceLastMessage} days ago. ` +
      `The new message may be unrelated to previous topics — use your judgment and treat it as a fresh inquiry if so.`;
  }

  return prompt;
}

// ── Helper: Parse Claude's response ──────────
function parseClaudeResponse(raw: string): RouteParseResult {
  const lines = raw.trim().split("\n");
  const firstLine = lines[0].trim();
  const restOfResponse = lines.slice(1).join("\n").trim();

  // Split first line on pipe to extract optional subject
  // e.g. "DRAFT 0.87 | Appointment inquiry - balayage pricing"
  const [routePart, subjectPart] = firstLine.split("|").map((s) => s.trim());
  const subject = subjectPart?.length ? subjectPart : null;
  const routeUpper = routePart.toUpperCase();

  const draftMatch = routeUpper.match(/^DRAFT\s+(0\.\d{1,2}|1\.00?)$/);

  if (draftMatch) {
    return {
      code: "DRAFT",
      confidence: parseFloat(draftMatch[1]),
      response_text: restOfResponse,
      subject,
      escalation_type: null,
      lead_priority: null,
    };
  }

  if (routeUpper.startsWith("IGNORE")) {
    return { code: "IGNORE", confidence: null, response_text: restOfResponse, subject, escalation_type: null, lead_priority: null };
  }

  if (routeUpper.startsWith("ESCALATE")) {
    // Parse escalation subtypes:
    //   ESCALATE | subject              → frustrated (backwards compat)
    //   ESCALATE_FRUSTRATED | subject   → frustrated
    //   ESCALATE_KB_GAP | subject       → kb_gap
    //   ESCALATE_LEAD | subject         → lead (no priority)
    //   ESCALATE_LEAD HIGH | subject    → lead, high priority
    let escalation_type: "frustrated" | "kb_gap" | "lead" = "frustrated";
    let lead_priority: "high" | "mid" | "low" | null = null;

    if (routeUpper.startsWith("ESCALATE_KB_GAP")) {
      escalation_type = "kb_gap";
    } else if (routeUpper.startsWith("ESCALATE_LEAD")) {
      escalation_type = "lead";
      const afterLead = routeUpper.replace("ESCALATE_LEAD", "").trim();
      if (afterLead === "HIGH") lead_priority = "high";
      else if (afterLead === "MID") lead_priority = "mid";
      else if (afterLead === "LOW") lead_priority = "low";
    }

    return { code: "ESCALATE", confidence: null, response_text: restOfResponse, subject, escalation_type, lead_priority };
  }

  // Fallback: check last line for routing code (Claude sometimes appends it after tool use)
  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1].trim();
    const [lastRoutePart, lastSubjectPart] = lastLine.split("|").map((s) => s.trim());
    const lastRouteUpper = lastRoutePart.toUpperCase();
    const lastSubject = lastSubjectPart?.length ? lastSubjectPart : null;
    const bodyWithoutLast = lines.slice(0, -1).join("\n").trim();

    const lastDraftMatch = lastRouteUpper.match(/^DRAFT\s+(0\.\d{1,2}|1\.00?)$/);
    if (lastDraftMatch) {
      return { code: "DRAFT", confidence: parseFloat(lastDraftMatch[1]), response_text: bodyWithoutLast, subject: lastSubject, escalation_type: null, lead_priority: null };
    }
    if (lastRouteUpper.startsWith("IGNORE")) {
      return { code: "IGNORE", confidence: null, response_text: bodyWithoutLast, subject: lastSubject, escalation_type: null, lead_priority: null };
    }
    if (lastRouteUpper.startsWith("ESCALATE")) {
      let escalation_type: "frustrated" | "kb_gap" | "lead" = "frustrated";
      let lead_priority: "high" | "mid" | "low" | null = null;
      if (lastRouteUpper.startsWith("ESCALATE_KB_GAP")) escalation_type = "kb_gap";
      else if (lastRouteUpper.startsWith("ESCALATE_LEAD")) {
        escalation_type = "lead";
        const afterLead = lastRouteUpper.replace("ESCALATE_LEAD", "").trim();
        if (afterLead === "HIGH") lead_priority = "high";
        else if (afterLead === "MID") lead_priority = "mid";
        else if (afterLead === "LOW") lead_priority = "low";
      }
      return { code: "ESCALATE", confidence: null, response_text: bodyWithoutLast, subject: lastSubject, escalation_type, lead_priority };
    }
  }

  // Fallback: Claude didn't follow format
  console.warn("Claude response did not start with a routing code. Raw:", raw.slice(0, 100));
  return { code: "DRAFT", confidence: 0.0, response_text: raw, subject: null, escalation_type: null, lead_priority: null };
}

// ── Pub/Sub notification resolver ────────────────────────────────────────────
// Decodes the Pub/Sub push notification, fetches new messages from Gmail
// using history since last_history_id, and returns structured payloads.
async function resolvePubSubNotification(
  body: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>
): Promise<InboundEmailPayload[]> {

  // Decode the base64 Pub/Sub data field
  const rawData = (body.message as Record<string, string>).data;
  const dataJson = atob(rawData.replace(/-/g, "+").replace(/_/g, "/"));
  const { emailAddress, historyId } = JSON.parse(dataJson) as {
    emailAddress: string;
    historyId: string;
  };

  console.log(`Pub/Sub notification for ${emailAddress}, historyId: ${historyId}`);

  // Find the matching provider record so we know the org and have credentials
  const { data: provider, error: providerError } = await supabase
    .schema("comms").from("email_providers")
    .select(
      "id, organization_id, provider, last_history_id, " +
      "access_token_encrypted, refresh_token_encrypted, token_expires_at"
    )
    .eq("provider_account_email", emailAddress)
    .eq("status", "active")
    .single();

  if (providerError || !provider) {
    // Orphaned Gmail watch — the mailbox was once connected but the provider
    // row is gone or inactive. Google keeps pushing notifications until the
    // watch expires (~7 days). Nothing to do but drop the notification.
    console.warn(`Ignoring Pub/Sub notification for unknown mailbox ${emailAddress} — orphaned watch, will expire on its own`);
    return [];
  }

  // Get a valid access token
  const accessToken = await getGmailAccessToken(supabase, provider);

  // Fetch history since last known historyId
  // This returns only what changed since we last processed — avoids reprocessing
  const startHistoryId = provider.last_history_id ?? historyId;
  console.log("startHistoryId:", startHistoryId, "notification historyId:", historyId); // TEMP
  const newMessages = await fetchGmailHistory(accessToken, startHistoryId);
  console.log("fetchGmailHistory returned:", newMessages.length, "messages", newMessages); // TEMP

  if (newMessages.length === 0) {
    // Update historyId even if no new messages, so we stay current
    await supabase
      .schema("comms").from("email_providers")
      .update({ last_history_id: historyId })
      .eq("id", provider.id);
    return [];
  }

  // Fetch full message details for each new message ID
  const payloads: InboundEmailPayload[] = [];
  for (const messageId of newMessages) {
    try {
      const payload = await fetchGmailMessage(
        accessToken,
        messageId,
        provider.organization_id
      );
      if (payload) payloads.push(payload);
      console.log("fetchGmailMessage result for", messageId, ":", payload ? "got payload" : "null"); // TEMP
    } catch (e) {
      // Log but continue — don't let one bad message block the rest
      console.error(`Failed to fetch message ${messageId}:`, e.message);
    }
  }

  // Advance the history cursor so next notification starts from here
  await supabase
    .schema("comms").from("email_providers")
    .update({ last_history_id: historyId })
    .eq("id", provider.id);

  return payloads;
}

// ── Gmail history fetcher ─────────────────────────────────────────────────────
// Returns message IDs of emails added to the inbox since startHistoryId.
// Filters to INBOX label only and skips sent messages (role='SENT') to avoid
// the function processing its own outbound replies.
async function fetchGmailHistory(
  accessToken: string,
  startHistoryId: string
): Promise<string[]> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
  url.searchParams.set("startHistoryId", startHistoryId);
  url.searchParams.set("historyTypes", "messageAdded");
  url.searchParams.set("labelId", "INBOX");

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gmail history fetch failed: ${err}`);
  }

  const data = await response.json();

  if (!data.history) return []; // No changes since last historyId

  // Extract unique message IDs from all history records
  const messageIds = new Set<string>();
  for (const record of data.history) {
    for (const added of record.messagesAdded ?? []) {
      // Skip if message has SENT label — that's our own outbound reply
      const labels: string[] = added.message?.labelIds ?? [];
      if (!labels.includes("SENT")) {
        messageIds.add(added.message.id);
      }
    }
  }

  return Array.from(messageIds);
}

// ── Calendly tool use ────────────────────────────────────────────────────────

const CALENDLY_TOOLS = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Check available appointment times on the business calendar. Use this when a customer asks about availability, wants to book an appointment, or asks when they can come in.",
      parameters: {
        type: "object",
        properties: {
          start_date: {
            type: "string",
            description: "Start date in YYYY-MM-DD format. Defaults to today.",
          },
          end_date: {
            type: "string",
            description: "End date in YYYY-MM-DD format. Defaults to 7 days from start_date.",
          },
          event_type_name: {
            type: "string",
            description: "Name of the specific service/event type. If omitted, checks the default.",
          },
        },
        required: [] as string[],
      },
    },
  },
];

const BOOK_APPOINTMENT_TOOL = {
  type: "function",
  function: {
    name: "book_appointment",
    description:
      "Book an appointment on the business calendar. Creates a Google Calendar event and sends the customer a calendar invite. Use ONLY after the customer has confirmed a specific time and provided their name and email.",
    parameters: {
      type: "object",
      properties: {
        start_time: {
          type: "string",
          description: "The EXACT start_time_iso value from check_availability results. Copy it verbatim — never construct or modify datetime strings yourself.",
        },
        duration_minutes: {
          type: "number",
          description: "Duration from check_availability's duration_minutes field.",
        },
        customer_name: {
          type: "string",
          description: "Customer's full name.",
        },
        customer_email: {
          type: "string",
          description: "Customer's email address (calendar invite sent here).",
        },
        service_name: {
          type: "string",
          description: "Name of the service being booked.",
        },
        notes: {
          type: "string",
          description: "Additional details or special requests from the customer.",
        },
      },
      required: ["start_time", "duration_minutes", "customer_name", "customer_email"] as string[],
    },
  },
};

const SUBMIT_RESPONSE_TOOL = {
  type: "function",
  function: {
    name: "submit_response",
    description: "Submit your final response to the customer. You MUST call this tool for EVERY response. Put your entire customer-facing message in response_text — do not output any text outside of this tool.",
    parameters: {
      type: "object",
      properties: {
        response_text: {
          type: "string",
          description: "Your complete response to the customer. Do NOT include any routing codes or metadata in this text.",
        },
        routing: {
          type: "string",
          enum: ["DRAFT", "IGNORE", "ESCALATE_FRUSTRATED", "ESCALATE_KB_GAP", "ESCALATE_LEAD_HIGH", "ESCALATE_LEAD_MID", "ESCALATE_LEAD_LOW"],
          description: "DRAFT: normal response. IGNORE: spam/not a real inquiry. ESCALATE_FRUSTRATED: customer is upset or threatening. ESCALATE_KB_GAP: question outside your knowledge. ESCALATE_LEAD_HIGH/MID/LOW: potential sales lead with priority.",
        },
        confidence: {
          type: "number",
          description: "0.00–1.00. How confident you are this response fully addresses the customer. Be conservative — below 0.75 if uncertain about any detail.",
        },
        subject: {
          type: "string",
          description: "2–5 word summary of the conversation topic (e.g. 'Haircut appointment Tuesday').",
        },
      },
      required: ["response_text", "routing", "confidence", "subject"] as string[],
    },
  },
};

// Parse an OpenAI-format tool_call arguments JSON string safely.
function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    console.warn("Malformed tool arguments:", raw?.slice(0, 200));
    return {};
  }
}

function parseSubmitResponse(input: Record<string, unknown>): RouteParseResult {
  const routing = (input.routing as string) || "DRAFT";
  const text = (input.response_text as string) || "";
  // Kimi sometimes returns confidence as 0-100 instead of 0-1 — normalize
  // and clamp so the DB CHECK constraint (0.00-1.00) always holds.
  let confidence = (input.confidence as number) ?? 0.5;
  if (confidence > 1) confidence = confidence / 100;
  confidence = Math.min(1, Math.max(0, confidence));
  const subject = (input.subject as string) || null;

  let code: "DRAFT" | "IGNORE" | "ESCALATE" = "DRAFT";
  let escalation_type: "frustrated" | "kb_gap" | "lead" | null = null;
  let lead_priority: "high" | "mid" | "low" | null = null;

  if (routing === "IGNORE") {
    code = "IGNORE";
  } else if (routing.startsWith("ESCALATE")) {
    code = "ESCALATE";
    if (routing.includes("KB_GAP")) escalation_type = "kb_gap";
    else if (routing.includes("LEAD")) {
      escalation_type = "lead";
      if (routing.includes("HIGH")) lead_priority = "high";
      else if (routing.includes("MID")) lead_priority = "mid";
      else if (routing.includes("LOW")) lead_priority = "low";
    } else {
      escalation_type = "frustrated";
    }
  }

  return { code, confidence, response_text: text, subject, escalation_type, lead_priority };
}

async function loadCalendlyIntegration(
  supabase: ReturnType<typeof createClient>,
  organizationId: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .schema("comms").from("integrations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("integration_type", "calendly")
    .eq("status", "active")
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

async function loadGoogleCalendarProvider(
  supabase: ReturnType<typeof createClient>,
  organizationId: string
): Promise<Record<string, unknown> | null> {
  // Priority 1: Dedicated google_calendar integration
  const { data: integration } = await supabase
    .schema("comms").from("integrations")
    .select("id, status, credentials_encrypted, credentials_expires_at, config, error_count")
    .eq("organization_id", organizationId)
    .eq("integration_type", "google_calendar")
    .eq("status", "active")
    .maybeSingle();

  if (integration) {
    const config = (integration.config as Record<string, unknown>) || {};
    return {
      source: "google_calendar",
      calendarId: (config.selected_calendar_id as string) || null,
      ...integration,
    };
  }

  // Priority 2: Gmail provider with calendar scope
  const { data, error } = await supabase
    .schema("comms").from("email_providers")
    .select("id, organization_id, provider, status, granted_scopes, access_token_encrypted, refresh_token_encrypted, token_expires_at, google_calendar_id")
    .eq("organization_id", organizationId)
    .eq("provider", "google")
    .eq("status", "active")
    .maybeSingle();

  if (error || !data) return null;
  const scopes = (data.granted_scopes as string[]) || [];
  if (!scopes.some((s) => s.includes("calendar"))) return null;
  return {
    source: "gmail",
    calendarId: (data.google_calendar_id as string) || null,
    ...data,
  };
}

async function executeBookingTool(
  supabase: ReturnType<typeof createClient>,
  googleProvider: Record<string, unknown>,
  input: Record<string, unknown>,
  businessTimezone: string,
  businessName: string
): Promise<Record<string, unknown>> {
  try {
    const accessToken = await getGmailAccessToken(supabase, googleProvider);

    const startTime = input.start_time as string;
    const durationMinutes = (input.duration_minutes as number) || 30;
    const customerName = input.customer_name as string;
    const customerEmail = ((input.customer_email as string) || "").trim();
    const serviceName = (input.service_name as string) || "Appointment";
    const notes = (input.notes as string) || "";

    if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      console.error("book_appointment: invalid email:", customerEmail);
      return {
        booked: false,
        error: `The email address "${customerEmail}" is not valid. Please ask the customer for a valid email address and try again.`,
      };
    }

    const startDate = new Date(startTime);
    const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
    const safeTz = safeTimezone(businessTimezone);

    const eventBody = {
      summary: `${serviceName} - ${customerName}`,
      description: `Booked via ${businessName} AI receptionist (Horus Desk).\n\nCustomer: ${customerName}\nEmail: ${customerEmail}${notes ? `\nNotes: ${notes}` : ""}`,
      start: { dateTime: startDate.toISOString(), timeZone: safeTz },
      end: { dateTime: endDate.toISOString(), timeZone: safeTz },
      attendees: [{ email: customerEmail, displayName: customerName }],
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 60 },
          { method: "popup", minutes: 30 },
        ],
      },
    };

    const calId = encodeURIComponent((googleProvider.calendarId as string) || "primary");
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?sendUpdates=all`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(eventBody),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("Google Calendar events.insert failed:", errText);
      throw new Error(`Google Calendar API error: ${res.status}`);
    }

    const event = await res.json();

    return {
      booked: true,
      event_id: event.id,
      summary: event.summary,
      start: formatUtcToLocalTime(startDate.toISOString(), safeTz),
      end: formatUtcToLocalTime(endDate.toISOString(), safeTz),
      timezone: getTimezoneAbbr(startDate.toISOString(), safeTz),
      customer_email: customerEmail,
      note: `Calendar invite sent to ${customerEmail}. Confirm the booking to the customer and mention they will receive a calendar invite at their email.`,
    };
  } catch (err: any) {
    console.error("book_appointment failed:", err.message);
    return {
      booked: false,
      error: "Could not create the booking at this time.",
      note: "Apologize and offer to have someone from the business follow up to confirm the booking manually.",
    };
  }
}

async function getCalendlyAccessToken(
  supabase: ReturnType<typeof createClient>,
  integration: Record<string, unknown>
): Promise<string> {
  const { crypto } = await import("https://deno.land/std@0.177.0/crypto/mod.ts");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function getKey(secret: string): Promise<CryptoKey> {
    const keyData = encoder.encode(secret);
    const hash = await crypto.subtle.digest("SHA-256", keyData);
    return await crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async function decrypt(encryptedValue: string, key: CryptoKey): Promise<string> {
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
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(text));
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  }

  const encryptionKey = await getKey(Deno.env.get("TOKEN_ENCRYPTION_KEY")!);
  const now = new Date();
  const expiresAt = integration.credentials_expires_at
    ? new Date(integration.credentials_expires_at as string)
    : null;

  const credentialsJson = await decrypt(integration.credentials_encrypted as string, encryptionKey);
  const credentials = JSON.parse(credentialsJson);

  // If token is still valid with 5 minute buffer, use it
  if (expiresAt && expiresAt > new Date(now.getTime() + 5 * 60 * 1000)) {
    return credentials.access_token;
  }

  // Token expired — refresh it
  const tokenResponse = await fetch("https://auth.calendly.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: Deno.env.get("CALENDLY_CLIENT_ID")!,
      client_secret: Deno.env.get("CALENDLY_CLIENT_SECRET")!,
    }),
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    await supabase
      .schema("comms").from("integrations")
      .update({
        status: "error",
        last_error: `Token refresh failed: ${err}`,
        error_count: (integration.error_count as number || 0) + 1,
      })
      .eq("id", integration.id);
    throw new Error(`Calendly token refresh failed: ${err}`);
  }

  const tokens = await tokenResponse.json();
  const newExpiry = new Date(now.getTime() + (tokens.expires_in || 7200) * 1000);

  const newCredentials = JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || credentials.refresh_token,
  });
  const encryptedCredentials = await encrypt(newCredentials, encryptionKey);

  await supabase
    .schema("comms").from("integrations")
    .update({
      credentials_encrypted: encryptedCredentials,
      credentials_expires_at: newExpiry.toISOString(),
      status: "active",
      last_error: null,
    })
    .eq("id", integration.id);

  return tokens.access_token;
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function safeTimezone(tz: string): string {
  if (isValidTimezone(tz)) return tz;
  console.warn(`Invalid timezone "${tz}", falling back to UTC`);
  return "UTC";
}

function formatUtcToLocalTime(utcIso: string, tz: string): string {
  const safeTz = safeTimezone(tz);
  const d = new Date(utcIso);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTz,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return fmt.format(d);
}

function getTimezoneAbbr(utcIso: string, tz: string): string {
  const safeTz = safeTimezone(tz);
  const d = new Date(utcIso);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTz,
    timeZoneName: "short",
  });
  const parts = fmt.formatToParts(d);
  return parts.find((p) => p.type === "timeZoneName")?.value || safeTz;
}

async function executeCalendlyTool(
  supabase: ReturnType<typeof createClient>,
  integration: Record<string, unknown>,
  toolName: string,
  input: Record<string, unknown>,
  businessTimezone: string
): Promise<Record<string, unknown>> {
  try {
    const accessToken = await getCalendlyAccessToken(supabase, integration);
    const config = integration.config as Record<string, unknown>;
    const eventTypes = (config.event_types as Array<Record<string, unknown>>) || [];

    const eventTypeName = input.event_type_name as string | undefined;
    const eventType = eventTypeName
      ? eventTypes.find((et) =>
          (et.name as string).toLowerCase().includes(eventTypeName.toLowerCase())
        )
      : eventTypes[0];

    if (!eventType) {
      return {
        error: false,
        message: eventTypes.length
          ? `Available event types: ${eventTypes.map((et) => et.name).join(", ")}`
          : "No event types configured in Calendly.",
      };
    }

    if (toolName === "check_availability") {
      // Calendly requires start_time strictly in the future
      const nowPlus2Min = new Date(Date.now() + 2 * 60 * 1000);
      const startDate = (input.start_date as string) || nowPlus2Min.toISOString().slice(0, 10);
      const startDateObj = new Date(startDate + "T00:00:00Z");
      const startTime = startDateObj > nowPlus2Min
        ? startDateObj.toISOString()
        : nowPlus2Min.toISOString();
      // Default to 6 days out (stay within Calendly's 7-day max range)
      const endDateDefault = new Date(
        new Date(startTime).getTime() + 6 * 86400000
      ).toISOString().slice(0, 10);
      const endDate = (input.end_date as string) || endDateDefault;
      let endTime = new Date(endDate + "T23:59:59Z").toISOString();
      // Ensure end is always after start
      if (endTime <= startTime) {
        endTime = new Date(new Date(startTime).getTime() + 6 * 86400000).toISOString();
      }

      const url = `https://api.calendly.com/event_type_available_times?event_type=${encodeURIComponent(
        eventType.uri as string
      )}&start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Calendly availability API failed:", errText);
        throw new Error(`Calendly API error: ${res.status}`);
      }

      const data = await res.json();

      const collection = (data.collection || []).filter((s: any) => s.status === "available");
      const tzAbbr = collection.length > 0
        ? getTimezoneAbbr(collection[0].start_time, businessTimezone)
        : businessTimezone;
      const slots = collection.slice(0, 40).map((s: any) => ({
        time: formatUtcToLocalTime(s.start_time, businessTimezone),
        start_time_iso: s.start_time,
        scheduling_url: s.scheduling_url,
      }));

      return {
        available_times: slots,
        event_type: eventType.name,
        duration_minutes: eventType.duration,
        timezone: `${businessTimezone} (${tzAbbr})`,
        note: `All times shown are in ${tzAbbr}. When booking, you MUST pass the start_time_iso value exactly as provided — do NOT construct or modify datetime strings yourself. Each slot also includes a scheduling_url for manual booking.`,
      };
    }

    return { error: true, message: "Unknown tool" };
  } catch (err: any) {
    console.error(`Calendly tool ${toolName} failed:`, err.message);
    const config = integration.config as Record<string, unknown>;
    const userUri = config.calendly_user_uri as string;
    return {
      error: true,
      message: "Calendar service temporarily unavailable.",
      fallback_url: userUri
        ? `https://calendly.com/${userUri.split("/").pop()}`
        : null,
    };
  }
}

// ── Kimi (Telnyx) call with retry/backoff ────────────────────────────────────
// OpenAI-compatible chat completions with up to 3 attempts on transient failures
// (429 rate limit, 500/502/503/504 server errors, network errors).
// Sleeps 500ms → 1500ms between attempts. Non-retryable errors throw immediately.
async function callKimiWithRetry(params: Record<string, unknown>): Promise<any> {
  const delays = [500, 1500];
  let lastError: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(KIMI_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("TELNYX_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const status = res.status;
        const errBody = await res.text();
        const err: any = new Error(`Telnyx ${status}: ${errBody.slice(0, 300)}`);
        err.status = status;
        throw err;
      }
      return await res.json();
    } catch (err: any) {
      lastError = err;
      const status = err?.status;
      // status undefined = network/fetch failure — retryable
      const retryable = status === undefined || status === 429 || status === 500 ||
        status === 502 || status === 503 || status === 504;
      if (!retryable || attempt === 2) throw err;
      console.warn(`Kimi call failed with ${status ?? "network error"}, retrying in ${delays[attempt]}ms (attempt ${attempt + 1}/3)`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastError;
}

// ── Gmail body extractor ──────────────────────────────────────────────────────
// Walks a Gmail message payload tree and returns the best plain-text body.
// Prefers text/plain; falls back to stripping tags from text/html.
function extractGmailBody(payload: any): string {
  if (!payload) return "";

  const findPart = (node: any, mimeType: string): any => {
    if (!node) return null;
    if (node.mimeType === mimeType && node.body?.data) return node;
    for (const part of node.parts ?? []) {
      const found = findPart(part, mimeType);
      if (found) return found;
    }
    return null;
  };

  const plain = findPart(payload, "text/plain");
  if (plain) return decodeGmailBase64(plain.body.data).trim();

  const html = findPart(payload, "text/html");
  if (html) return stripHtml(decodeGmailBase64(html.body.data));

  if (payload.body?.data) {
    const raw = decodeGmailBase64(payload.body.data);
    return payload.mimeType === "text/html" ? stripHtml(raw) : raw.trim();
  }

  return "";
}

// ── Gmail full message fetcher ────────────────────────────────────────────────
// Fetches a single Gmail message by ID and maps it to InboundEmailPayload.
// Returns null if the message should be skipped (e.g. draft, sent by us).
async function fetchGmailMessage(
  accessToken: string,
  gmailMessageId: string,
  organizationId: string
): Promise<InboundEmailPayload | null> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gmail message fetch failed for ${gmailMessageId}: ${err}`);
  }

  const msg = await response.json();

  // Extract headers into a lookup map
  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    headers[h.name.toLowerCase()] = h.value;
  }

  const senderRaw = headers["from"] ?? "";
  const senderEmail = extractEmail(senderRaw);
  const senderName = extractName(senderRaw);
  // Keep the subject exactly as received — including empty. Gmail's client-side
  // threading normalizes subjects and falls back to empty, so injecting a
  // placeholder like "(no subject)" breaks threading on first reply.
  const subject = headers["subject"] ?? "";
  const messageId = headers["message-id"] ?? gmailMessageId;
  const threadId = msg.threadId;

  if (!senderEmail) {
    console.warn(`Could not parse sender from: ${senderRaw}`);
    return null;
  }

  // Extract plain text body
  const bodyText = extractGmailBody(msg.payload);
  if (!bodyText) {
    console.warn(`No text body found in message ${gmailMessageId}`);
    return null;
  }

  return {
    provider: "google",
    organization_id: organizationId,
    sender_email: senderEmail,
    sender_name: senderName ?? undefined,
    subject,
    body_text: bodyText,
    thread_id: threadId,
    message_id: messageId,
    received_at: new Date(parseInt(msg.internalDate)).toISOString(),
  };
}

// ── Gmail token refresher ─────────────────────────────────────────────────────
// Returns a valid access token, refreshing via OAuth if the current one is
// expired or missing. Updates the provider record with the new token.
async function getGmailAccessToken(
  supabase: ReturnType<typeof createClient>,
  provider: Record<string, unknown>
): Promise<string> {
  const { crypto } = await import("https://deno.land/std@0.177.0/crypto/mod.ts");
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
    // The original base64 string is stored inside the hex-encoded bytes
    let base64: string;
    if (encryptedValue.startsWith("\\x")) {
      const hex = encryptedValue.slice(2);
      base64 = new TextDecoder().decode(
        new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
      );
    } else {
      // Fallback: already a plain base64 string
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
  const fiveMinBuffer = new Date(now.getTime() + 5 * 60 * 1000);

  // ── Integration source (google_calendar in integrations table) ──
  if (provider.source === "google_calendar") {
    const credentialsJson = await decrypt(provider.credentials_encrypted as string, encryptionKey);
    const credentials = JSON.parse(credentialsJson);

    const gcExpiry = provider.credentials_expires_at
      ? new Date(provider.credentials_expires_at as string)
      : null;

    if (gcExpiry && gcExpiry > fiveMinBuffer) {
      return credentials.access_token;
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
        client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
        refresh_token: credentials.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    if (!tokenResponse.ok) {
      const err = await tokenResponse.text();
      console.error("Google Calendar token refresh failed:", err);
      await supabase
        .schema("comms").from("integrations")
        .update({
          status: "error",
          last_error: `Token refresh failed: ${err}`,
          error_count: ((provider.error_count as number) || 0) + 1,
        })
        .eq("id", provider.id);
      throw new Error(`Google Calendar token refresh failed: ${err}`);
    }

    const tokens = await tokenResponse.json();
    const newCreds = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || credentials.refresh_token,
    });
    const encryptedCreds = await encrypt(newCreds, encryptionKey);
    const newExpiry = new Date(now.getTime() + tokens.expires_in * 1000);

    await supabase
      .schema("comms").from("integrations")
      .update({
        credentials_encrypted: encryptedCreds,
        credentials_expires_at: newExpiry.toISOString(),
        status: "active",
        last_error: null,
      })
      .eq("id", provider.id);

    return tokens.access_token;
  }

  // ── Gmail source (email_providers table) ──
  const expiresAt = provider.token_expires_at
    ? new Date(provider.token_expires_at as string)
    : null;

  // If token is still valid with 5 minute buffer, use it
  if (
    provider.access_token_encrypted &&
    expiresAt &&
    expiresAt > fiveMinBuffer
  ) {
    return await decrypt(provider.access_token_encrypted as string, encryptionKey);
  }

  // Token expired or missing — refresh it
  console.log("access_token_encrypted type:", typeof provider.access_token_encrypted); // TEMP
  console.log("access_token_encrypted value:", String(provider.access_token_encrypted).slice(0, 50)); // TEMP
  const refreshToken = await decrypt(
    provider.refresh_token_encrypted as string,
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
      .schema("comms").from("email_providers")
      .update({ status: "expired", error_message: `Token refresh failed: ${err}` })
      .eq("id", provider.id);
    throw new Error(`Token refresh failed: ${err}`);
  }

  const tokens = await tokenResponse.json();
  const newExpiry = new Date(now.getTime() + tokens.expires_in * 1000);

  // Encrypt and store refreshed token
  const encryptedNewAccess = await encrypt(tokens.access_token, encryptionKey);
  await supabase
    .schema("comms").from("email_providers")
    .update({
      access_token_encrypted: encryptedNewAccess,
      token_expires_at: newExpiry.toISOString(),
      status: "active",
      error_message: null,
    })
    .eq("id", provider.id);

  return tokens.access_token;
}

// ── Escalation Notifier ───────────────────────────────────────────────────────
// Sends escalation notification to configured recipients,
// falling back to the connected inbox if none are configured.
async function sendEscalationNotification(
  supabase: ReturnType<typeof createClient>,
  params: {
    organizationId: string;
    conversationId: string;
    customerEmail: string;
    subject: string | null;
    history: Array<{ role: string; content: string; created_at: string }>;
    aiResponse: string;
    escalationType: "frustrated" | "kb_gap" | "lead";
    leadPriority: "high" | "mid" | "low" | null;
  }
): Promise<void> {
  const { organizationId, conversationId, customerEmail, subject, history, aiResponse, escalationType, leadPriority } = params;

  const historyText = [
    ...history.map((m) => {
      const role = m.role === "customer" ? `Customer (${customerEmail})` : "AI Receptionist";
      const time = new Date(m.created_at).toLocaleString("en-US", { timeZone: "UTC" });
      return `[${time} UTC] ${role}:\n${m.content}`;
    }),
    `[NOW] AI Receptionist (escalation response):\n${aiResponse}`,
  ].join("\n\n---\n\n");

  const { emailSubject, body } = buildEscalationEmail({
    escalationType,
    leadPriority,
    customerEmail,
    subject,
    conversationId,
    historyText,
  });

  await sendOrgNotification(
    supabase,
    organizationId,
    "escalation",
    emailSubject,
    body,
    escalationType
  );
}

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

// ── Unified notification sender ───────────────────────────────────────────────
// Sends to configured notification_recipients for the event type,
// falling back to the connected inbox if none are configured.
async function sendOrgNotification(
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
  eventType: "escalation" | "usage_limit" | "system",
  subject: string,
  body: string,
  escalationSubType?: "frustrated" | "kb_gap" | "lead"
): Promise<void> {
  const { data: provider } = await supabase
    .schema("comms").from("email_providers")
    .select("id, provider, provider_account_email, access_token_encrypted, refresh_token_encrypted, token_expires_at")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .maybeSingle();

  if (!provider) {
    console.warn(`No active provider for org ${organizationId} — cannot send ${eventType} notification`);
    return;
  }

  let recipientQuery = supabase
    .schema("comms").from("notification_recipients")
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
    ? recipients.map(r => r.name ? `${r.name} <${r.email}>` : r.email)
    : [provider.provider_account_email];

  const accessToken = await getNotificationAccessToken(supabase, provider);
  if (!accessToken) return;

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
      console.error(`Failed to send ${eventType} notification to ${toAddress}:`, e.message);
    }
  }
}

// ── Notification token getter ─────────────────────────────────────────────────
async function getNotificationAccessToken(
  supabase: ReturnType<typeof createClient>,
  provider: Record<string, unknown>
): Promise<string | null> {
  try {
    const { crypto: cryptoMod } = await import("https://deno.land/std@0.177.0/crypto/mod.ts");
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    async function getKey(secret: string): Promise<CryptoKey> {
      const keyData = enc.encode(secret);
      const hash = await cryptoMod.subtle.digest("SHA-256", keyData);
      return await cryptoMod.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["decrypt"]);
    }

    async function decrypt(encryptedValue: string, key: CryptoKey): Promise<string> {
      let base64: string;
      if (encryptedValue.startsWith("\\x")) {
        const hex = encryptedValue.slice(2);
        base64 = dec.decode(new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))));
      } else {
        base64 = encryptedValue;
      }
      const combined = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const decrypted = await cryptoMod.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
      return dec.decode(decrypted);
    }

    const encryptionKey = await getKey(Deno.env.get("TOKEN_ENCRYPTION_KEY")!);
    const now = new Date();
    const expiresAt = provider.token_expires_at ? new Date(provider.token_expires_at as string) : null;

    if (provider.access_token_encrypted && expiresAt && expiresAt > new Date(now.getTime() + 5 * 60 * 1000)) {
      return await decrypt(provider.access_token_encrypted as string, encryptionKey);
    }

    const refreshToken = await decrypt(provider.refresh_token_encrypted as string, encryptionKey);

    if (provider.provider === "microsoft") {
      const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
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
      });

      if (!tokenRes.ok) return null;
      const tokens = await tokenRes.json();
      return tokens.access_token;
    }

    // Default: Google
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
        client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!tokenRes.ok) return null;
    const tokens = await tokenRes.json();
    return tokens.access_token;
  } catch (e) {
    console.error("getNotificationAccessToken error:", e.message);
    return null;
  }
}

function decodeGmailBase64(data: string): string {
  // Gmail uses URL-safe base64 — convert back before decoding
  return atob(data.replace(/-/g, "+").replace(/_/g, "/"));
}

function stripHtml(html: string): string {
  // Basic HTML tag stripping — good enough for plain text extraction
  return html
    .replace(/<style[^>]*>.*?<\/style>/gis, "")
    .replace(/<script[^>]*>.*?<\/script>/gis, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── Email address parsers ─────────────────────────────────────────────────────
// Gmail "From" headers come in two formats:
//   "John Smith <john@example.com>"
//   "john@example.com"
function extractEmail(from: string): string | null {
  const match = from.match(/<([^>]+)>/) ?? from.match(/([^\s]+@[^\s]+)/);
  return match ? match[1].trim().toLowerCase() : null;
}

function extractName(from: string): string | null {
  const match = from.match(/^([^<]+)<.+>/);
  return match ? match[1].trim().replace(/"/g, "") : null;
}

// ── Usage limit helpers (inlined — no shared module) ─────────────────────────

// Check if an org has exceeded their monthly message limit.
async function checkUsageLimit(
  supabase: ReturnType<typeof createClient>,
  organizationId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_usage_exceeded", {
    org_id: organizationId,
  });
  if (error) {
    console.error("Usage limit check failed:", error.message);
    return false; // Fail open
  }
  return data === true;
}

// Increment monthly usage counter after a successful AI exchange.
// Returns true if this call pushed the org over their limit.
async function incrementUsage(
  supabase: ReturnType<typeof createClient>,
  organizationId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc("increment_message_usage", {
    org_id: organizationId,
  });
  if (error) {
    console.error("Usage increment failed:", error.message);
    return false;
  }
  return data === true;
}

// Disable the widget and send a limit-exceeded notification email
// to the business's connected inbox.
async function handleLimitExceeded(
  supabase: ReturnType<typeof createClient>,
  organizationId: string
): Promise<void> {
  await supabase
    .schema("core").from("widget_configs")
    .update({
      enabled: false,
      disable_reason: "usage_limit",
      disable_message: "Chat is temporarily unavailable. Please contact us directly.",
    })
    .eq("organization_id", organizationId);

  const { data: updated } = await supabase
    .schema("core").from("organizations")
    .update({ limit_notified_at: new Date().toISOString() })
    .eq("id", organizationId)
    .is("limit_notified_at", null)
    .select("name, message_limit_per_month, messages_used_this_month")
    .single();

  if (!updated) return;

  const now = new Date();
  const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const body = [
    `⚠️ MESSAGE LIMIT REACHED — ${updated.name}`,
    ``,
    `Your Horus Desk AI receptionist has reached its monthly message limit.`,
    ``,
    `Limit:    ${updated.message_limit_per_month.toLocaleString()} messages/month`,
    `Used:     ${updated.messages_used_this_month.toLocaleString()} messages`,
    `Resets:   ${resetDate}`,
    ``,
    `The chat widget on your website has been temporarily disabled.`,
    `Email responses are also paused until the limit resets.`,
    ``,
    `To restore service immediately, please upgrade your plan at:`,
    `https://app.horusdesk.com/billing`,
    ``,
    `Your service will automatically resume on ${resetDate} if you remain on your current plan.`,
    ``,
    `— Horus Desk`,
  ].join("\n");

  await sendOrgNotification(
    supabase,
    organizationId,
    "usage_limit",
    `⚠️ Monthly message limit reached — ${updated.name}`,
    body
  );
}

// ── Default system prompt template ───────────
// Used when org.ai_system_prompt is null.
// Placeholders are interpolated at runtime.
const DEFAULT_SYSTEM_PROMPT = `
You are a professional AI receptionist for {business_name}.
Your tone should be {ai_tone}, warm, and concise.

{business_description}

## Booking
{booking_instructions}
Booking link: {booking_url}

## Policies
Cancellation: {cancellation_policy}
Deposit: {deposit_policy}

## Your Responsibilities
- Answer questions about services, pricing, hours, and booking
- Never promise a specific appointment time — direct customers to the booking link
- Never make up information not provided in this prompt
- If a question falls outside your knowledge, say so honestly and offer to have someone follow up
`.trim();

const DEFAULT_ROUTING_RULES = `Classify every response using the submit_response tool:
- DRAFT — Normal inquiry you can answer. Set confidence 0.00–1.00 based on how sure you are.
- IGNORE — Spam, test messages, gibberish, not a real inquiry.
- ESCALATE_FRUSTRATED — Customer is upset, angry, or making threats.
- ESCALATE_KB_GAP — Question is outside your knowledge base.
- ESCALATE_LEAD_HIGH — Customer is ready to buy or book.
- ESCALATE_LEAD_MID — Customer is actively interested.
- ESCALATE_LEAD_LOW — Customer is just browsing.

Always use the submit_response tool to deliver your response — never output raw text without calling it.`;
