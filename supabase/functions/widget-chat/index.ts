// ============================================
// EDGE FUNCTION: widget-chat
// Public endpoint — no JWT required.
// Receives a message from the chat widget,
// runs the AI pipeline inline, and returns
// Claude's response in the same HTTP call.
// No delivery queue — response is synchronous.
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

// ── Types ────────────────────────────────────
interface ChatRequest {
  apiKey: string;
  sessionId: string;
  visitorData?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  message: string;
  timestamp?: string;
  metadata?: {
    url?: string;
    userAgent?: string;
    referrer?: string;
    timezone?: string;
  };
}

interface ChatResponse {
  message: string;
  quickReplies?: string[];
  escalated: boolean;
  sessionId: string;
}

// ── Constants ────────────────────────────────
const CONVERSATION_WINDOW = 12;
const SUMMARY_THRESHOLD = 8;
const RECENT_MESSAGES_KEEP = 4;
const INACTIVE_DAYS_THRESHOLD = 30;
const KB_CHUNK_LIMIT = 6;
const DEFAULT_AUTO_SEND_THRESHOLD = 0.75;
const MONTHLY_PLAN_DAYS = 30;          // Duration of a monthly subscription period
const CONVERSATION_STARTED_SIGNAL = "[CONVERSATION_STARTED]";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key, X-Widget-Version",
};

// ── Main Handler ─────────────────────────────
Deno.serve(async (req: Request) => {
  // ── CORS preflight ────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...CORS_HEADERS, "Access-Control-Allow-Origin": "*" },
    });
  }

  // ── HISTORY SYNC (GET) ────────────────────
  // Lets the widget recover messages it missed (e.g. the HTTP response was
  // lost after a client timeout or the mobile tab was suspended mid-flight).
  if (req.method === "GET") {
    return await handleHistoryRequest(req);
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const anthropic = new Anthropic({
    apiKey: Deno.env.get("ANTHROPIC_API_KEY")!,
  });

  let body: ChatRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400, "*");
  }

  const { apiKey, sessionId, visitorData, message, metadata } = body;

  if (!apiKey || !sessionId || !message) {
    return errorResponse("Missing required fields: apiKey, sessionId, message", 400, "*");
  }

  // ── 1. VALIDATE API KEY ───────────────────
  const { data: widgetConfig, error: configError } = await supabase
    .schema("core").from("widget_configs")
    .select("organization_id, enabled, welcome_message, colors, allowed_domains, rate_limit_per_hour, rate_limit_per_ip_per_minute")
    .eq("api_key", apiKey)
    .single();

  if (configError || !widgetConfig) {
    return errorResponse("Invalid API key", 401, "*");
  }

  if (!widgetConfig.enabled) {
    return errorResponse("Widget is disabled", 403, "*");
  }

  const origin = req.headers.get("origin") ?? "*";
  const allowedOrigin = getAllowedOrigin(origin, widgetConfig.allowed_domains);
  const organizationId = widgetConfig.organization_id;

  // ── 2. HANDLE CONVERSATION_STARTED ───────
  // Widget sends this signal when a session opens. Return welcome message
  // from config — no AI call needed, no message stored.
  if (message === CONVERSATION_STARTED_SIGNAL) {
    return jsonResponse({
      message: widgetConfig.welcome_message ?? "Hi there! How can I help you today?",
      quickReplies: [],
      escalated: false,
      sessionId,
    }, 200, allowedOrigin);
  }

  // ── 2b/2c. RATE LIMITING + MONTHLY USAGE LIMIT (in parallel) ──
  // Extract real IP — Supabase Edge Functions receive it via CF-Connecting-IP
  const ipAddress = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown";

  const [rateLimitResult, isOverLimit] = await Promise.all([
    checkRateLimit(supabase, apiKey, ipAddress, {
      perHour: widgetConfig.rate_limit_per_hour ?? 120,
      perIpPerMinute: widgetConfig.rate_limit_per_ip_per_minute ?? 10,
    }),
    checkUsageLimit(supabase, organizationId),
  ]);

  if (!rateLimitResult.allowed) {
    return new Response(
      JSON.stringify({ error: "Too many requests. Please slow down." }),
      {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOrigin,
          "Vary": "Origin",
          "Retry-After": String(rateLimitResult.retryAfterSeconds ?? 60),
        },
      }
    );
  }

  if (isOverLimit) {
    await supabase
      .schema("core").from("widget_configs")
      .update({ enabled: false, disable_reason: "usage_limit" })
      .eq("organization_id", organizationId);
    return errorResponse(
      "Monthly message limit reached. Please contact the business directly.",
      429,
      allowedOrigin
    );
  }

  try {
    // ── 3. LOAD ORGANIZATION CONFIG ───────────
    const { data: org, error: orgError } = await supabase
      .schema("core").from("organizations")
      .select(`
        id,
        ai_tone,
        auto_send_enabled,
        auto_send_min_confidence,
        subscription_end_date,
        ai_system_prompt,
        ai_system_prompt_version,
        business_hours_timezone,
        business_profiles (
          business_name,
          description,
          booking_url,
          booking_instructions,
          cancellation_policy,
          deposit_policy
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
      .eq("id", organizationId)
      .single();

    if (orgError || !org) {
      throw new Error(`Organization not found: ${organizationId}`);
    }

    // ── 3b. CHECK SUBSCRIPTION EXPIRY ─────────
    // Allow a 7-day grace period after subscription_end_date before blocking
    // service. cron-maintenance sends a warning email and eventually flips
    // ai_responses_enabled + widget_configs.enabled as backup enforcement.
    if (org.subscription_end_date) {
      const now = new Date();
      const endDate = new Date(org.subscription_end_date);
      const graceDeadline = new Date(endDate.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (now > graceDeadline) {
        return errorResponse(
          "Service subscription has expired. Please contact the business directly.",
          403,
          allowedOrigin
        );
      }
    }

    // ── 4. IDENTITY RESOLUTION ────────────────
    // Use email from visitorData if provided, otherwise use sessionId as identifier
    const visitorEmail = visitorData?.email?.toLowerCase().trim() ?? null;
    const visitorName = visitorData?.name?.trim() ?? null;

    let contactId: string;

    if (visitorEmail) {
      // Look up by email alias
      const { data: alias } = await supabase
        .schema("crm").from("contact_aliases")
        .select("contact_id")
        .eq("organization_id", organizationId)
        .eq("alias_type", "email")
        .eq("alias_hash", visitorEmail)
        .maybeSingle();

      if (alias) {
        contactId = alias.contact_id;
        await supabase
          .schema("crm").from("contacts")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("id", contactId);
      } else {
        // Create new contact
        const { data: newContact, error: contactError } = await supabase
          .schema("crm").from("contacts")
          .insert({
            organization_id: organizationId,
            primary_email: visitorEmail,
            name: visitorName,
          })
          .select("id")
          .single();

        if (contactError || !newContact) {
          throw new Error(`Failed to create contact: ${contactError?.message}`);
        }

        contactId = newContact.id;

        await supabase.schema("crm").from("contact_aliases").insert({
          contact_id: contactId,
          organization_id: organizationId,
          alias_type: "email",
          alias_value: visitorEmail,
          source: "widget_form",
        });
      }
    } else {
      // No email — use sessionId as a custom alias to maintain identity
      // across messages within the same widget session
      const { data: alias } = await supabase
        .schema("crm").from("contact_aliases")
        .select("contact_id")
        .eq("organization_id", organizationId)
        .eq("alias_type", "custom")
        .eq("alias_hash", sessionId)
        .maybeSingle();

      if (alias) {
        contactId = alias.contact_id;
        await supabase
          .schema("crm").from("contacts")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("id", contactId);
      } else {
        const { data: newContact, error: contactError } = await supabase
          .schema("crm").from("contacts")
          .insert({
            organization_id: organizationId,
            primary_email: `widget-${sessionId}@anonymous.horusdesk.internal`,
            name: visitorName ?? "Website Visitor",
          })
          .select("id")
          .single();

        if (contactError || !newContact) {
          throw new Error(`Failed to create anonymous contact: ${contactError?.message}`);
        }

        contactId = newContact.id;

        await supabase.schema("crm").from("contact_aliases").insert({
          contact_id: contactId,
          organization_id: organizationId,
          alias_type: "custom",
          alias_value: sessionId,
          source: "widget_session",
        });
      }
    }

    // ── 5. CONVERSATION RESOLUTION ────────────
    // sessionId is the thread identifier for webchat
    const { data: conversation, error: convError } = await supabase
      .schema("messaging").from("conversations")
      .upsert(
        {
          organization_id: organizationId,
          contact_id: contactId,
          channel: "webchat",
          external_thread_id: sessionId,
          customer_email: visitorEmail,
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

    // If escalated, still reply but flag it — visitor shouldn't hit a wall
    const isEscalated = conversation.status === "escalated";

    // If AI is manually disabled for this conversation, return a holding message
    if (!conversation.ai_enabled) {
      return jsonResponse({
        message: "A team member will be with you shortly.",
        quickReplies: [],
        escalated: true,
        sessionId,
      }, 200, allowedOrigin);
    }

    // ── 6. SAVE INBOUND MESSAGE ───────────────
    const { data: inboundMessage, error: msgError } = await supabase
      .schema("messaging").from("messages")
      .insert({
        conversation_id: conversation.id,
        organization_id: organizationId,
        role: "customer",
        content: message,
        status: "sent",
        external_message_id: `widget-${sessionId}-${Date.now()}`,
      })
      .select("id")
      .single();

    if (msgError || !inboundMessage) {
      throw new Error(`Failed to save inbound message: ${msgError?.message}`);
    }

    // ── 7. LOG ANALYTICS EVENT ────────────────
    await supabase.schema("analytics").from("analytics_events").insert({
      organization_id: organizationId,
      event_type: "message_received",
      metadata: {
        conversation_id: conversation.id,
        channel: "webchat",
        provider: "widget",
      },
    });

    // Start loading the Calendly integration in parallel with the
    // history/KB work below — they are independent.
    const calendlyIntegrationPromise = loadCalendlyIntegration(supabase, organizationId);

    // ── 8. CONTEXT ASSEMBLY ───────────────────

    // 8a. Conversation history — count total then decide: full window or summary + recent
    const { count: totalMsgCount } = await supabase
      .schema("messaging").from("messages")
      .select("*", { count: "exact", head: true })
      .eq("conversation_id", conversation.id)
      .in("status", ["sent", "auto_sent", "pending_review"])
      .neq("id", inboundMessage.id);

    let history: Array<{ role: string; content: string; created_at: string }>;
    let conversationSummary: string | null = null;

    if ((totalMsgCount ?? 0) > SUMMARY_THRESHOLD) {
      conversationSummary = await getOrUpdateSummary(
        supabase, anthropic, conversation.id,
        totalMsgCount ?? 0, conversation.summary, conversation.summary_msg_count ?? 0,
        ["sent", "auto_sent", "pending_review"]
      );

      const { data: recentMessages } = await supabase
        .schema("messaging").from("messages")
        .select("role, content, created_at")
        .eq("conversation_id", conversation.id)
        .in("status", ["sent", "auto_sent", "pending_review"])
        .neq("id", inboundMessage.id)
        .order("created_at", { ascending: false })
        .limit(RECENT_MESSAGES_KEEP);

      history = (recentMessages ?? []).reverse();
    } else {
      const { data: historyMessages } = await supabase
        .schema("messaging").from("messages")
        .select("role, content, created_at")
        .eq("conversation_id", conversation.id)
        .in("status", ["sent", "auto_sent", "pending_review"])
        .neq("id", inboundMessage.id)
        .order("created_at", { ascending: false })
        .limit(CONVERSATION_WINDOW);

      history = (historyMessages ?? []).reverse();
    }

    // 8b. KB chunk retrieval (Haiku selects relevant chunks by code)
    const recentHistory = (history ?? []).slice(-3);
    const kbChunks = await selectKbChunks(
      anthropic, supabase, organizationId,
      message, recentHistory
    );

    // 8c. Stale conversation flag
    const lastMessageAt = new Date(conversation.last_message_at);
    const daysSinceLastMessage = Math.floor(
      (Date.now() - lastMessageAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    const isStaleConversation = daysSinceLastMessage >= INACTIVE_DAYS_THRESHOLD;

    // Await the Calendly integration load started before the history work
    const calendlyIntegration = await calendlyIntegrationPromise;
    const googleCalendarProvider = calendlyIntegration
      ? await loadGoogleCalendarProvider(supabase, organizationId)
      : null;

    const businessTimezone = (org.business_hours_timezone as string) || "UTC";
    const customerTimezone = safeTimezone(metadata?.timezone || businessTimezone);

    // ── 9. BUILD SYSTEM PROMPT ────────────────
    let systemPrompt = buildSystemPrompt({
      org,
      kbChunks: kbChunks ?? [],
      isStaleConversation,
      daysSinceLastMessage,
      visitorData,
      isWebchat: true,
      calendlyConnected: !!calendlyIntegration,
      googleCalendarAvailable: !!googleCalendarProvider,
      customerTimezone,
    });

    if (conversationSummary) {
      systemPrompt += `\n\n## Conversation Summary (earlier messages)\n${conversationSummary}`;
    }

    // ── 10. BUILD MESSAGES ARRAY ──────────────
    const claudeMessages: Anthropic.MessageParam[] = [
      ...history.map((m) => ({
        role: m.role === "customer" ? ("user" as const) : ("assistant" as const),
        content: m.content,
      })),
      {
        role: "user" as const,
        content: message,
      },
    ];

    // ── 11. CALL CLAUDE ───────────────────────
    const startTime = Date.now();
    const toolsArr: any[] = [SUBMIT_RESPONSE_TOOL];
    if (calendlyIntegration) {
      toolsArr.push(...CALENDLY_TOOLS);
      if (googleCalendarProvider) toolsArr.push(BOOK_APPOINTMENT_TOOL);
    }

    let claudeResponse = await callClaudeWithRetry(anthropic, {
      model: "claude-sonnet-5",
      max_tokens: 1000,
      system: systemPrompt,
      messages: claudeMessages,
      tools: toolsArr,
      tool_choice: { type: "any" },
    });

    // Handle tool use loop (max 3 iterations)
    let totalInputTokens = claudeResponse.usage.input_tokens;
    let totalOutputTokens = claudeResponse.usage.output_tokens;
    let toolUseIterations = 0;
    let submitResponseData: Record<string, unknown> | null = null;

    while (
      claudeResponse.stop_reason === "tool_use" &&
      toolUseIterations < 3
    ) {
      toolUseIterations++;
      const toolUseBlocks = claudeResponse.content.filter(
        (block: any) => block.type === "tool_use"
      );

      console.log(`Tool use iteration ${toolUseIterations}, tools called:`, toolUseBlocks.map((t: any) => t.name));

      // Check if submit_response was called — that's the final response
      const submitBlock = toolUseBlocks.find((t: any) => t.name === "submit_response");
      if (submitBlock) {
        submitResponseData = submitBlock.input;
      }

      // Execute other tools (not submit_response)
      const toolResults: any[] = [];
      for (const toolUse of toolUseBlocks) {
        if (toolUse.name === "submit_response") {
          toolResults.push({
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: JSON.stringify({ received: true }),
          });
          continue;
        }
        let result;
        if (toolUse.name === "book_appointment" && googleCalendarProvider) {
          const profile = (org.business_profiles as Record<string, unknown>[])?.[0];
          const bName = (profile?.business_name as string) || "the business";
          result = await executeBookingTool(
            supabase, googleCalendarProvider, toolUse.input,
            businessTimezone, bName, customerTimezone
          );
        } else if (calendlyIntegration) {
          result = await executeCalendlyTool(
            supabase, calendlyIntegration, toolUse.name, toolUse.input,
            customerTimezone
          );
        } else {
          result = { error: true, message: "Unknown tool" };
        }
        toolResults.push({
          type: "tool_result" as const,
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      // If submit_response was called, we're done
      if (submitResponseData) break;

      claudeMessages.push({ role: "assistant", content: claudeResponse.content });
      claudeMessages.push({ role: "user", content: toolResults });

      claudeResponse = await callClaudeWithRetry(anthropic, {
        model: "claude-sonnet-5",
        max_tokens: 1000,
        system: systemPrompt,
        messages: claudeMessages,
        tools: toolsArr,
        tool_choice: { type: "any" },
      });

      totalInputTokens += claudeResponse.usage.input_tokens;
      totalOutputTokens += claudeResponse.usage.output_tokens;
    }

    const processingTimeMs = Date.now() - startTime;

    const rawResponseText = claudeResponse.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("");

    const tokensUsed = totalInputTokens + totalOutputTokens;
    const costEstimate =
      totalInputTokens * 0.000003 +
      totalOutputTokens * 0.000015;

    // ── 12. PARSE ROUTING ────────────────
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
      parsed.response_text = "I've looked into that for you. Could you tell me a bit more about what you need so I can help further?";
      parsed.confidence = 0.50;
    }

    // ── 13. ROUTE ─────────────────────────────
    // Webchat routing differences vs email:
    // - IGNORE → treat as DRAFT (never ignore a live visitor)
    // - ESCALATE → reply normally, flag conversation
    // - DRAFT → save and return directly (no delivery queue)

    const effectiveCode = parsed.code === "IGNORE" ? "DRAFT" : parsed.code;
    const responseText = parsed.code === "IGNORE"
      ? (parsed.response_text || "I'm not sure I understood that. Could you rephrase?")
      : parsed.response_text;

    const willEscalate = effectiveCode === "ESCALATE" || isEscalated;
    const messageStatus = "auto_sent"; // Webchat always auto-sends

    // Save AI message
    const { data: aiMessage, error: aiMsgError } = await supabase
      .schema("messaging").from("messages")
      .insert({
        conversation_id: conversation.id,
        organization_id: organizationId,
        role: "ai",
        content: responseText,
        status: messageStatus,
        routing_code: effectiveCode,
        confidence_score_reported: parsed.confidence,
        ai_model: "claude-sonnet-5",
        ai_prompt_version: org.ai_system_prompt_version,
        processing_time_ms: processingTimeMs,
        tokens_used: tokensUsed,
        cost_estimate: costEstimate,
        escalation_type: parsed.escalation_type,
        lead_priority: parsed.lead_priority,
      })
      .select("id")
      .single();

    if (aiMsgError || !aiMessage) {
      throw new Error(`Failed to save AI message: ${aiMsgError?.message}`);
    }

    // If escalating, flip conversation status and schedule debounced notification
    if (effectiveCode === "ESCALATE" && !isEscalated) {
      // Set escalation_notify_at to 10 min from now — process-delivery-queue
      // will pick it up, fetch the full chat history at that time, and send
      // one consolidated notification email instead of one per escalation.
      const notifyAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      await supabase
        .schema("messaging").from("conversations")
        .update({
          status: "escalated",
          escalation_reason: "AI determined human intervention required",
          escalation_type: parsed.escalation_type,
          lead_priority: parsed.lead_priority,
          escalation_notify_at: notifyAt,
        })
        .eq("id", conversation.id);

      await supabase.schema("analytics").from("analytics_events").insert({
        organization_id: organizationId,
        event_type: "escalated",
        metadata: {
          conversation_id: conversation.id,
          channel: "webchat",
          escalation_type: parsed.escalation_type,
          lead_priority: parsed.lead_priority,
        },
      });
    } else if (effectiveCode === "ESCALATE" && isEscalated) {
      // Already escalated — update the type/priority but don't move the timer
      await supabase
        .schema("messaging").from("conversations")
        .update({
          escalation_type: parsed.escalation_type,
          lead_priority: parsed.lead_priority,
        })
        .eq("id", conversation.id);
    }

    // Update conversation timestamps
    await supabase
      .schema("messaging").from("conversations")
      .update({ last_ai_response_at: new Date().toISOString() })
      .eq("id", conversation.id);

    if (parsed.subject) {
      await supabase
        .schema("messaging").from("conversations")
        .update({ subject: parsed.subject })
        .eq("id", conversation.id);
    }

    await supabase.schema("analytics").from("analytics_events").insert({
      organization_id: organizationId,
      event_type: "ai_generated",
      metadata: {
        conversation_id: conversation.id,
        routing_code: effectiveCode,
        confidence: parsed.confidence,
        channel: "webchat",
      },
    });

    // ── 15. INCREMENT USAGE COUNTER ───────────
    // Count this exchange (inbound + AI reply = 1) toward monthly limit.
    // If this call just pushed the org over the limit, disable widget and notify.
    if (effectiveCode !== "IGNORE") {
      const justExceeded = await incrementUsage(supabase, organizationId);
      if (justExceeded) {
        // Fire and forget — don't block the response to the visitor
        handleLimitExceeded(supabase, organizationId).catch((e) =>
          console.error("handleLimitExceeded error:", e.message)
        );
      }
    }

    // ── 14. RETURN RESPONSE ───────────────────
    return jsonResponse({
      message: responseText,
      quickReplies: [],
      escalated: willEscalate,
      sessionId,
    } as ChatResponse, 200, allowedOrigin);

  } catch (err) {
    console.error("widget-chat error:", err.message);
    return errorResponse("Something went wrong. Please try again.", 500, allowedOrigin ?? "*");
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status: number, allowedOrigin: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": allowedOrigin,
      "Vary": "Origin",
    },
  });
}

function errorResponse(message: string, status: number, allowedOrigin: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": allowedOrigin,
      "Vary": "Origin",
    },
  });
}

// ── History sync handler (GET) ──────────────────────────────────────────────
// Returns the stored conversation messages for a widget session so the client
// can recover any responses it never received (timeouts, suspended tabs, etc).
async function handleHistoryRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const apiKey = url.searchParams.get("apiKey");
  const sessionId = url.searchParams.get("sessionId");

  if (!apiKey || !sessionId) {
    return errorResponse("Missing required params: apiKey, sessionId", 400, "*");
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: widgetConfig, error: configError } = await supabase
    .schema("core").from("widget_configs")
    .select("organization_id, allowed_domains")
    .eq("api_key", apiKey)
    .single();

  if (configError || !widgetConfig) {
    return errorResponse("Invalid API key", 401, "*");
  }

  const origin = req.headers.get("origin") ?? "*";
  const allowedOrigin = getAllowedOrigin(origin, widgetConfig.allowed_domains);

  const { data: conversation } = await supabase
    .schema("messaging").from("conversations")
    .select("id")
    .eq("organization_id", widgetConfig.organization_id)
    .eq("channel", "webchat")
    .eq("external_thread_id", sessionId)
    .maybeSingle();

  if (!conversation) {
    return jsonResponse({ sessionId, messages: [] }, 200, allowedOrigin);
  }

  const { data: messages, error: msgError } = await supabase
    .schema("messaging").from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversation.id)
    .in("status", ["sent", "auto_sent", "pending_review"])
    .order("created_at", { ascending: true })
    .limit(200);

  if (msgError) {
    console.error("History fetch failed:", msgError.message);
    return errorResponse("Failed to load history", 500, allowedOrigin);
  }

  return jsonResponse({
    sessionId,
    messages: (messages ?? [])
      .filter((m) => m.role === "customer" || m.role === "ai")
      .map((m) => ({ role: m.role, content: m.content, createdAt: m.created_at })),
  }, 200, allowedOrigin);
}

function getAllowedOrigin(origin: string, allowedDomains: string[]): string {
  if (!allowedDomains || allowedDomains.length === 0) return "*";
  try {
    const originUrl = new URL(origin);
    const hostname = originUrl.hostname.replace(/^www\./, "");
    const isAllowed = allowedDomains.some((domain) => {
      const d = domain.replace(/^www\./, "");
      return hostname === d || hostname.endsWith(`.${d}`);
    });
    return isAllowed ? origin : "null";
  } catch {
    return "null";
  }
}

function extractKeywords(text: string): string {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to",
    "for", "of", "with", "is", "are", "was", "were", "be", "been",
    "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "i", "you", "we", "they",
    "he", "she", "it", "my", "your", "our", "their", "this", "that",
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w))
    .slice(0, 10)
    .join(" | ");
}

// ── Helper: Haiku-powered KB chunk selection ──
// Loads all chunks for the org, sends them to Haiku with their codes,
// and lets Haiku pick 1-6 relevant chunks. Falls back to keyword search on failure.
async function selectKbChunks(
  anthropic: Anthropic,
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
  currentMessage: string,
  recentHistory: Array<{ role: string; content: string }>,
): Promise<Array<{ content: string }>> {
  try {
    // 1. Load all chunks for the org
    const { data: allChunks } = await supabase
      .schema("kb").from("kb_chunks")
      .select("chunk_code, content")
      .eq("organization_id", organizationId)
      .order("chunk_index", { ascending: true });

    if (!allChunks || allChunks.length === 0) return [];

    // 2. Build chunk index for Haiku
    const chunkIndex = allChunks
      .map((c: { chunk_code: string; content: string }) => `[${c.chunk_code}] ${c.content}`)
      .join("\n\n");

    // 3. Build conversation context (last assistant + customer exchange only)
    const lastTwo = recentHistory.slice(-2);
    let contextBlock = "";
    if (lastTwo.length > 0) {
      contextBlock = "\nCONVERSATION CONTEXT:\n" + lastTwo
        .map((m) => `${m.role === "customer" ? "Customer" : "Assistant"}: ${m.content}`)
        .join("\n") + "\n";
    }

    // 4. Call Haiku with a single user message (no multi-turn conversation)
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      system: "You are a retrieval classifier. Return ONLY space-separated chunk codes. No other text.",
      messages: [{
        role: "user",
        content: `KB ENTRIES:\n${chunkIndex}\n${contextBlock}\nCURRENT CUSTOMER MESSAGE:\n${currentMessage}\n\nReturn the 1-6 most relevant KB entry codes for the customer's message. If none are relevant, return NONE.`,
      }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";

    if (!text || text.toUpperCase() === "NONE") return [];

    // 5. Parse codes and filter chunks
    const returnedCodes = new Set(
      text.toLowerCase().replace(/[,|]/g, " ").split(/\s+/).filter(Boolean)
    );
    const selected = allChunks
      .filter((c: { chunk_code: string }) => returnedCodes.has(c.chunk_code))
      .slice(0, KB_CHUNK_LIMIT)
      .map((c: { content: string }) => ({ content: c.content }));

    if (selected.length === 0) {
      console.warn("Haiku returned codes that matched no chunks:", text);
      return fallbackSearch(supabase, organizationId, currentMessage);
    }

    console.log(`KB chunks selected by Haiku: ${selected.length} of ${allChunks.length}`);
    return selected;
  } catch (error) {
    console.warn("selectKbChunks failed, falling back:", error.message);
    return fallbackSearch(supabase, organizationId, currentMessage);
  }
}

async function fallbackSearch(
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
  message: string,
): Promise<Array<{ content: string }>> {
  const keywords = extractKeywords(message);
  const { data } = await supabase
    .schema("kb").from("kb_chunks")
    .select("content")
    .eq("organization_id", organizationId)
    .textSearch("search_vector", keywords, { type: "websearch" })
    .limit(KB_CHUNK_LIMIT);
  return data ?? [];
}

interface RouteParseResult {
  code: "IGNORE" | "ESCALATE" | "DRAFT";
  confidence: number | null;
  subject: string | null;
  response_text: string;
  escalation_type: "frustrated" | "kb_gap" | "lead" | null;
  lead_priority: "high" | "mid" | "low" | null;
}

function parseClaudeResponse(raw: string): RouteParseResult {
  const lines = raw.trim().split("\n");
  const firstLine = lines[0].trim();
  const restOfResponse = lines.slice(1).join("\n").trim();

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

  console.warn("Claude response missing routing code. Raw:", raw.slice(0, 100));
  return { code: "DRAFT", confidence: 0.0, response_text: raw, subject: null, escalation_type: null, lead_priority: null };
}

// ── Helper: Conversation summarization ──────────────
async function getOrUpdateSummary(
  supabase: ReturnType<typeof createClient>,
  anthropic: Anthropic,
  conversationId: string,
  totalCount: number,
  existingSummary: string | null,
  summaryMsgCount: number,
  statuses: string[]
): Promise<string | null> {
  const messagesToSummarize = totalCount - RECENT_MESSAGES_KEEP;

  if (existingSummary && summaryMsgCount >= messagesToSummarize) {
    return existingSummary;
  }

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
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: "Summarize this conversation concisely. You MUST preserve ALL specific details: full names, email addresses, phone numbers, dates, times, prices, appointment details, booking references, and any commitments made. Output only the summary paragraph.",
      messages: [{ role: "user", content: input }],
    });

    const summary = response.content[0]?.type === "text" ? response.content[0].text : "";

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

function buildSystemPrompt(params: {
  org: Record<string, unknown>;
  kbChunks: Array<{ content: string }>;
  isStaleConversation: boolean;
  daysSinceLastMessage: number;
  visitorData?: { name?: string; email?: string; phone?: string };
  isWebchat: boolean;
  calendlyConnected?: boolean;
  googleCalendarAvailable?: boolean;
  customerTimezone?: string;
}): string {
  const { org, kbChunks, isStaleConversation, daysSinceLastMessage, visitorData, calendlyConnected, googleCalendarAvailable, customerTimezone } = params;
  const profile = (org.business_profiles as Record<string, unknown>[])?.[0];
  const hours = org.business_hours as Array<Record<string, unknown>>;
  const services = (org.business_services as Array<Record<string, unknown>>)
    ?.filter((s) => s.is_active);

  const basePrompt = (org.ai_system_prompt as string) ?? DEFAULT_SYSTEM_PROMPT;
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
      prompt = prompt.replace(
        new RegExp(`[^\n]*\\{${placeholder.slice(1, -1)}\\}[^\n]*\n?`, "g"),
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
    const tzLabel = customerTimezone || "the customer's timezone";
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

  // Append KB chunks
  if (kbChunks.length > 0) {
    const kbText = kbChunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n");
    prompt += `\n\n## Relevant Knowledge Base Excerpts\n${kbText}`;
  }

  // Visitor context — helps Claude personalise responses
  if (visitorData && (visitorData.name || visitorData.email)) {
    const parts = [];
    if (visitorData.name) parts.push(`Name: ${visitorData.name}`);
    if (visitorData.email) parts.push(`Email: ${visitorData.email}`);
    if (visitorData.phone) parts.push(`Phone: ${visitorData.phone}`);
    prompt += `\n\n## Visitor Info\n${parts.join("\n")}`;
  }

  // Stale conversation warning
  if (isStaleConversation) {
    prompt += `\n\n## Note\nThis conversation was last active ${daysSinceLastMessage} days ago. ` +
      `Treat new messages as a fresh inquiry if topics have changed.`;
  }

  // Current date so Claude knows what "today" and "tomorrow" mean
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const dayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getUTCDay()];
  prompt += `\n\n## Current Date\nToday is ${dayName}, ${dateStr} (UTC).`;

  // Webchat-specific instruction — responses should be conversational and concise
  prompt += `\n\n## Channel\nYou are responding via a live website chat widget. ` +
    `Keep responses concise (2-4 sentences). ` +
    `The visitor expects an immediate reply — be warm and direct.`;

  const routingRules = (org.routing_rules as string) || DEFAULT_ROUTING_RULES;
  prompt += `\n\n## Routing Rules\n${routingRules}`;

  return prompt;
}

// ── Rate limiting helpers (inlined — no shared module) ────────────────────────

interface RateLimitResult {
  allowed: boolean;
  reason?: "ip_rate_limit" | "key_rate_limit";
  retryAfterSeconds?: number;
}

// Check and increment rate limit counters for a request.
// Uses a fixed 1-minute window for IP limits and 1-hour window for key limits.
async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  apiKey: string,
  ipAddress: string,
  config: { perHour: number; perIpPerMinute: number }
): Promise<RateLimitResult> {
  const now = new Date();

  // ── Per-IP-per-minute check ───────────────
  const ipWindowStart = new Date(
    Math.floor(now.getTime() / (60 * 1000)) * (60 * 1000)
  );
  const ipWindowExpiry = new Date(ipWindowStart.getTime() + 2 * 60 * 1000);
  const ipBucketKey = `ip:${ipAddress}:${apiKey}`;

  const ipCount = await upsertBucket(supabase, ipBucketKey, ipWindowStart, ipWindowExpiry);

  if (ipCount !== null && ipCount > config.perIpPerMinute) {
    return {
      allowed: false,
      reason: "ip_rate_limit",
      retryAfterSeconds: Math.ceil((ipWindowExpiry.getTime() - now.getTime()) / 1000),
    };
  }

  // ── Per-key-per-hour check ────────────────
  const keyWindowStart = new Date(
    Math.floor(now.getTime() / (60 * 60 * 1000)) * (60 * 60 * 1000)
  );
  const keyWindowExpiry = new Date(keyWindowStart.getTime() + 2 * 60 * 60 * 1000);
  const keyBucketKey = `key:${apiKey}`;

  const keyCount = await upsertBucket(supabase, keyBucketKey, keyWindowStart, keyWindowExpiry);

  if (keyCount !== null && keyCount > config.perHour) {
    return {
      allowed: false,
      reason: "key_rate_limit",
      retryAfterSeconds: Math.ceil((keyWindowExpiry.getTime() - now.getTime()) / 1000),
    };
  }

  return { allowed: true };
}

// Upsert a rate limit bucket and return the new request count.
// Returns null on error (caller should fail open).
async function upsertBucket(
  supabase: ReturnType<typeof createClient>,
  bucketKey: string,
  windowStart: Date,
  expiresAt: Date
): Promise<number | null> {
  const { data: inserted, error: insertError } = await supabase
    .schema("system").from("rate_limit_buckets")
    .upsert(
      {
        bucket_key: bucketKey,
        window_start: windowStart.toISOString(),
        request_count: 1,
        expires_at: expiresAt.toISOString(),
      },
      { onConflict: "bucket_key,window_start", ignoreDuplicates: true }
    )
    .select("request_count")
    .maybeSingle();

  if (!insertError && inserted) {
    return inserted.request_count;
  }

  // Row already exists — increment it via SQL function
  const { data: updated, error: updateError } = await supabase.rpc(
    "increment_rate_limit_bucket",
    {
      p_bucket_key: bucketKey,
      p_window_start: windowStart.toISOString(),
    }
  );

  if (updateError || updated === null) {
    console.error("Failed to increment rate limit bucket:", updateError?.message);
    return null; // Fail open
  }

  return updated as number;
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
  // Disable the widget
  await supabase
    .schema("core").from("widget_configs")
    .update({
      enabled: false,
      disable_reason: "usage_limit",
      disable_message: "Chat is temporarily unavailable. Please contact us directly.",
    })
    .eq("organization_id", organizationId);

  // Mark notification as sent — prevent duplicate emails
  const { data: updated } = await supabase
    .schema("core").from("organizations")
    .update({ limit_notified_at: new Date().toISOString() })
    .eq("id", organizationId)
    .is("limit_notified_at", null)
    .select("name, message_limit_per_month, messages_used_this_month")
    .single();

  if (!updated) return; // Already notified

  // Load the active email provider for sending the notification
  const { data: provider } = await supabase
    .schema("comms").from("email_providers")
    .select(
      "provider_account_email, access_token_encrypted, " +
      "refresh_token_encrypted, token_expires_at"
    )
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .maybeSingle();

  if (!provider) {
    console.warn(`No active email provider for org ${organizationId} — cannot send limit notification`);
    return;
  }

  const { crypto: cryptoMod } = await import("https://deno.land/std@0.177.0/crypto/mod.ts");
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  async function getKeyLocal(secret: string): Promise<CryptoKey> {
    const keyData = enc.encode(secret);
    const hash = await cryptoMod.subtle.digest("SHA-256", keyData);
    return await cryptoMod.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["decrypt"]);
  }

  async function decryptLocal(encryptedValue: string, key: CryptoKey): Promise<string> {
    let base64: string;
    if (encryptedValue.startsWith("\\x")) {
      const hex = encryptedValue.slice(2);
      base64 = dec.decode(
        new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
      );
    } else {
      base64 = encryptedValue;
    }
    const combined = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await cryptoMod.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return dec.decode(decrypted);
  }

  try {
    const encryptionKey = await getKeyLocal(Deno.env.get("TOKEN_ENCRYPTION_KEY")!);
    const now = new Date();
    const expiresAt = provider.token_expires_at ? new Date(provider.token_expires_at) : null;

    let accessToken: string;

    if (
      provider.access_token_encrypted &&
      expiresAt &&
      expiresAt > new Date(now.getTime() + 5 * 60 * 1000)
    ) {
      accessToken = await decryptLocal(provider.access_token_encrypted as unknown as string, encryptionKey);
    } else {
      const refreshToken = await decryptLocal(
        provider.refresh_token_encrypted as unknown as string, encryptionKey
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
        console.error("Token refresh failed for limit notification");
        return;
      }
      const tokens = await tokenResponse.json();
      accessToken = tokens.access_token;
    }

    const businessEmail = provider.provider_account_email as string;
    const resetDate = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      1
    ).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

    const notifBody = [
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

    const notifSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(`⚠️ Monthly message limit reached — ${updated.name}`)))}?=`;

    const rawEmail = [
      `From: ${businessEmail}`,
      `To: ${businessEmail}`,
      `Subject: ${notifSubject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      notifBody,
    ].join("\r\n");

    const encodedEmail = btoa(unescape(encodeURIComponent(rawEmail)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const sendResponse = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: encodedEmail }),
      }
    );

    if (!sendResponse.ok) {
      const err = await sendResponse.text();
      console.error("Failed to send limit notification email:", err);
    } else {
      console.log("Limit notification email sent to", businessEmail);
    }
  } catch (e) {
    console.error("Limit notification error:", e.message);
  }
}

// ── Default system prompt ─────────────────────────────────────────────────────
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

// ── Calendly tool use ────────────────────────────────────────────────────────

const CALENDLY_TOOLS = [
  {
    name: "check_availability",
    description:
      "Check available appointment times on the business calendar. Use this when a customer asks about availability, wants to book an appointment, or asks when they can come in.",
    input_schema: {
      type: "object" as const,
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
];

const BOOK_APPOINTMENT_TOOL = {
  name: "book_appointment",
  description:
    "Book an appointment on the business calendar. Creates a Google Calendar event and sends the customer a calendar invite. Use ONLY after the customer has confirmed a specific time and provided their name and email.",
  input_schema: {
    type: "object" as const,
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
};

const SUBMIT_RESPONSE_TOOL = {
  name: "submit_response",
  description: "Submit your final response to the customer. You MUST call this tool for EVERY response. Put your entire customer-facing message in response_text — do not output any text outside of this tool.",
  input_schema: {
    type: "object" as const,
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
};

function parseSubmitResponse(input: Record<string, unknown>): RouteParseResult {
  const routing = (input.routing as string) || "DRAFT";
  const text = (input.response_text as string) || "";
  const confidence = (input.confidence as number) ?? 0.5;
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

async function getGoogleAccessToken(
  supabase: ReturnType<typeof createClient>,
  provider: Record<string, unknown>
): Promise<string> {
  const tokenEncryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY");
  if (!tokenEncryptionKey) throw new Error("Missing TOKEN_ENCRYPTION_KEY");

  const keyData = new TextEncoder().encode(tokenEncryptionKey);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  const cryptoKey = await crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

  async function decrypt(encryptedValue: string): Promise<string> {
    let base64 = encryptedValue;
    if (base64.startsWith("\\x")) {
      const hex = base64.slice(2);
      base64 = new TextDecoder().decode(
        new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
      );
    }
    const combined = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
    return new TextDecoder().decode(decrypted);
  }

  async function encrypt(text: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      new TextEncoder().encode(text)
    );
    const combined = new Uint8Array(iv.byteLength + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.byteLength);
    return btoa(String.fromCharCode(...combined));
  }

  // ── Integration source (google_calendar in integrations table) ──
  if (provider.source === "google_calendar") {
    const credentialsJson = await decrypt(provider.credentials_encrypted as string);
    const credentials = JSON.parse(credentialsJson);

    const gcExpiry = provider.credentials_expires_at as string | null;
    const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    if (gcExpiry && gcExpiry > fiveMinFromNow) {
      return credentials.access_token;
    }

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("GOOGLE_CLIENT_ID") || "",
        client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
        refresh_token: credentials.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Google Calendar token refresh failed:", errText);
      await supabase
        .schema("comms").from("integrations")
        .update({
          status: "error",
          last_error: `Token refresh failed: ${res.status}`,
          error_count: ((provider.error_count as number) || 0) + 1,
        })
        .eq("id", provider.id);
      throw new Error("Google Calendar token refresh failed");
    }

    const tokens = await res.json();
    const newCreds = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || credentials.refresh_token,
    });
    const encryptedCreds = await encrypt(newCreds);
    const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await supabase
      .schema("comms").from("integrations")
      .update({
        credentials_encrypted: encryptedCreds,
        credentials_expires_at: newExpiry,
        status: "active",
        last_error: null,
      })
      .eq("id", provider.id);

    return tokens.access_token;
  }

  // ── Gmail source (email_providers table) ──
  const expiresAt = provider.token_expires_at as string | null;
  const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  if (provider.access_token_encrypted && expiresAt && expiresAt > fiveMinFromNow) {
    return await decrypt(provider.access_token_encrypted as string);
  }

  const refreshToken = await decrypt(provider.refresh_token_encrypted as string);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") || "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Google token refresh failed:", errText);
    await supabase
      .schema("comms").from("email_providers")
      .update({ status: "expired", error_message: `Token refresh failed: ${res.status}` })
      .eq("id", provider.id);
    throw new Error("Google token refresh failed");
  }

  const tokens = await res.json();
  const encryptedAccess = await encrypt(tokens.access_token);
  const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await supabase
    .schema("comms").from("email_providers")
    .update({
      access_token_encrypted: encryptedAccess,
      token_expires_at: newExpiry,
      status: "active",
    })
    .eq("id", provider.id);

  return tokens.access_token;
}

async function executeBookingTool(
  supabase: ReturnType<typeof createClient>,
  googleProvider: Record<string, unknown>,
  input: Record<string, unknown>,
  businessTimezone: string,
  businessName: string,
  customerTimezone?: string
): Promise<Record<string, unknown>> {
  try {
    const accessToken = await getGoogleAccessToken(supabase, googleProvider);

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
    const bizTz = safeTimezone(businessTimezone);
    const displayTz = safeTimezone(customerTimezone || businessTimezone);

    const eventBody = {
      summary: `${serviceName} - ${customerName}`,
      description: `Booked via ${businessName} AI receptionist (Horus Desk).\n\nCustomer: ${customerName}\nEmail: ${customerEmail}${notes ? `\nNotes: ${notes}` : ""}`,
      start: { dateTime: startDate.toISOString(), timeZone: bizTz },
      end: { dateTime: endDate.toISOString(), timeZone: bizTz },
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
      start: formatUtcToLocalTime(startDate.toISOString(), displayTz),
      end: formatUtcToLocalTime(endDate.toISOString(), displayTz),
      timezone: getTimezoneAbbr(startDate.toISOString(), displayTz),
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

  if (expiresAt && expiresAt > new Date(now.getTime() + 5 * 60 * 1000)) {
    return credentials.access_token;
  }

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
  displayTimezone: string
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
        ? getTimezoneAbbr(collection[0].start_time, displayTimezone)
        : displayTimezone;
      const slots = collection.slice(0, 40).map((s: any) => ({
        time: formatUtcToLocalTime(s.start_time, displayTimezone),
        start_time_iso: s.start_time,
        scheduling_url: s.scheduling_url,
      }));

      return {
        available_times: slots,
        event_type: eventType.name,
        duration_minutes: eventType.duration,
        timezone: `${displayTimezone} (${tzAbbr})`,
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

// ── Claude call with retry/backoff ───────────────────────────────────────────
// Wraps anthropic.messages.create with up to 3 attempts on transient failures
// (529 overloaded, 500/502/503/504 server errors, 429 rate limit).
// Sleeps 500ms → 1500ms between attempts. Non-retryable errors throw immediately.
async function callClaudeWithRetry(anthropic: any, params: any): Promise<any> {
  const delays = [500, 1500];
  let lastError: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err: any) {
      lastError = err;
      const status = err?.status ?? err?.response?.status;
      const retryable = status === 429 || status === 500 || status === 502 ||
        status === 503 || status === 504 || status === 529;
      if (!retryable || attempt === 2) throw err;
      console.warn(`Claude call failed with ${status}, retrying in ${delays[attempt]}ms (attempt ${attempt + 1}/3)`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastError;
}
