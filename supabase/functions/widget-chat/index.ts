// ============================================
// EDGE FUNCTION: widget-chat
// Public endpoint — no JWT required.
// Receives a message from the chat widget,
// runs the AI pipeline inline, and returns
// Kimi's response in the same HTTP call.
// No delivery queue — response is synchronous.
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";

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
const CONVERSATION_WINDOW = 50;
const SUMMARY_THRESHOLD = 100;
const RECENT_MESSAGES_KEEP = 20;
const INACTIVE_DAYS_THRESHOLD = 30;
const DEFAULT_AUTO_SEND_THRESHOLD = 0.75;
const MONTHLY_PLAN_DAYS = 30;          // Duration of a monthly subscription period
const CONVERSATION_STARTED_SIGNAL = "[CONVERSATION_STARTED]";

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

  const bodyText = await req.json().catch(() => null);
  if (!bodyText) {
    return errorResponse("Invalid JSON", 400, "*");
  }
  const body = bodyText as ChatRequest;

  // ── EMPLOYEE TEST MODE ────────────────────
  // Server-to-server only: dashboard-api proxies employee playground requests
  // here with the service key. Runs the real AI pipeline (org config, KB,
  // system prompt, Kimi) but skips: API-key/widget checks, rate limits, usage
  // counters, identity/conversation/message persistence, calendar tools, and
  // escalation side-effects. Employee testing never touches client usage.
  if ((body as unknown as Record<string, unknown>).test_mode === true) {
    return await handleTestChat(req, supabase, body as unknown as Record<string, unknown>);
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
    const upsertPayload: Record<string, unknown> = {
      organization_id: organizationId,
      contact_id: contactId,
      channel: "webchat",
      external_thread_id: sessionId,
      customer_email: visitorEmail,
      status: "active",
      ai_enabled: true,
    };

    // Consent proof (pre-chat disclaimer acceptance) — written only when the
    // widget sends it; absent keys leave existing values untouched on upsert.
    const consent = (metadata as Record<string, unknown> | undefined)?.consent as
      Record<string, unknown> | undefined;
    if (consent?.accepted_at) {
      const acceptedAt = new Date(String(consent.accepted_at));
      if (!isNaN(acceptedAt.getTime())) {
        upsertPayload.consent_accepted_at = acceptedAt.toISOString();
        upsertPayload.consent_version = String(consent.disclaimer_version ?? "").slice(0, 64);
      }
    }

    const { data: conversation, error: convError } = await supabase
      .schema("messaging").from("conversations")
      .upsert(
        upsertPayload,
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
        supabase, conversation.id,
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

    // 8b. Load the org's full knowledge base (injected wholesale into the
    // system prompt — see KIMI constants above)
    const kbChunks = await loadAllKbChunks(supabase, organizationId);

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
    const kimiMessages: Array<Record<string, unknown>> = [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({
        role: m.role === "customer" ? "user" : "assistant",
        content: m.content,
      })),
      {
        role: "user",
        content: message,
      },
    ];

    // ── 11. CALL KIMI ─────────────────────────
    const startTime = Date.now();
    const toolsArr: any[] = [SUBMIT_RESPONSE_TOOL];
    if (calendlyIntegration) {
      toolsArr.push(...CALENDLY_TOOLS);
      if (googleCalendarProvider) toolsArr.push(BOOK_APPOINTMENT_TOOL);
    }

    // ── 11b. STREAMING MODE ─────────────────
    // Identical pipeline to the buffered path below, but the visitor watches
    // the reply generate: response_text tokens are forwarded as SSE delta
    // events, then a terminal done event carries the authoritative final
    // message + routing flags. ALL side effects (persistence, escalation,
    // usage counters, analytics) run exactly as in the buffered path, after
    // generation completes — even if the visitor disconnects mid-stream.
    if ((body as unknown as Record<string, unknown>).stream === true) {
      const encoder = new TextEncoder();
      const streamBody = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (obj: unknown) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            } catch { /* visitor gone — keep processing so the reply is still saved */ }
          };
          try {
            let totalInputTokens = 0;
            let totalCachedTokens = 0;
            let totalOutputTokens = 0;
            let toolUseIterations = 0;
            let submitResponseData: Record<string, unknown> | null = null;
            let rawResponseText = "";

            const runStreamedCall = async () => {
              const upstream = await callKimiStream({
                model: KIMI_MODEL,
                max_tokens: 2000,
                reasoning_effort: REASONING_EFFORT,
                messages: kimiMessages,
                tools: toolsArr,
                tool_choice: "required",
                stream: true,
                stream_options: { include_usage: true },
              });
              const r = await pumpKimiStream(upstream, (t) => send({ type: "delta", text: t }));
              totalInputTokens += r.usage.prompt_tokens;
              totalCachedTokens += r.usage.cached_tokens;
              totalOutputTokens += r.usage.completion_tokens;
              rawResponseText = r.content;
              return r;
            };

            // Tool-use loop — same semantics as the buffered loop below
            let r = await runStreamedCall();
            while (r.finishReason === "tool_calls" && toolUseIterations < 3) {
              toolUseIterations++;
              console.log(`Tool use iteration ${toolUseIterations} (stream), tools called:`, r.toolCalls.map((t) => t.name));

              const submitCall = r.toolCalls.find((t) => t.name === "submit_response");
              if (submitCall) {
                submitResponseData = parseToolArguments(submitCall.arguments);
              }

              const toolResultMessages: any[] = [];
              for (const toolCall of r.toolCalls) {
                const toolInput = parseToolArguments(toolCall.arguments);
                if (toolCall.name === "submit_response") {
                  toolResultMessages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify({ received: true }),
                  });
                  continue;
                }
                let result;
                if (toolCall.name === "book_appointment" && googleCalendarProvider) {
                  const profile = (org.business_profiles as Record<string, unknown>[])?.[0];
                  const bName = (profile?.business_name as string) || "the business";
                  result = await executeBookingTool(
                    supabase, googleCalendarProvider, toolInput,
                    businessTimezone, bName, customerTimezone
                  );
                } else if (calendlyIntegration) {
                  result = await executeCalendlyTool(
                    supabase, calendlyIntegration, toolCall.name, toolInput,
                    customerTimezone
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

              if (submitResponseData) break;

              kimiMessages.push({
                role: "assistant",
                content: r.content ?? "",
                tool_calls: r.toolCalls.map((t) => ({
                  id: t.id,
                  type: "function",
                  function: { name: t.name, arguments: t.arguments },
                })),
              });
              kimiMessages.push(...toolResultMessages);

              r = await runStreamedCall();
            }

            const processingTimeMs = Date.now() - startTime;
            const tokensUsed = totalInputTokens + totalOutputTokens;
            const costEstimate =
              (totalInputTokens - totalCachedTokens) * KIMI_COST_INPUT +
              totalCachedTokens * KIMI_COST_CACHED_INPUT +
              totalOutputTokens * KIMI_COST_OUTPUT;

            // ── 12-15. PARSE / ROUTE / SAVE / USAGE — identical to buffered ──
            let parsed: RouteParseResult;
            if (submitResponseData) {
              parsed = parseSubmitResponse(submitResponseData);
            } else {
              parsed = parseClaudeResponse(rawResponseText);
              if (toolUseIterations > 0 && parsed.confidence === 0.0) {
                parsed.confidence = 0.85;
              }
            }
            if (!parsed.response_text?.trim()) {
              parsed.response_text = "I've looked into that for you. Could you tell me a bit more about what you need so I can help further?";
              parsed.confidence = 0.50;
            }

            const effectiveCode = parsed.code === "IGNORE" ? "DRAFT" : parsed.code;
            const responseText = parsed.code === "IGNORE"
              ? (parsed.response_text || "I'm not sure I understood that. Could you rephrase?")
              : parsed.response_text;
            const willEscalate = effectiveCode === "ESCALATE" || isEscalated;
            const messageStatus = "auto_sent"; // Webchat always auto-sends

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
                ai_model: KIMI_MODEL,
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

            if (effectiveCode === "ESCALATE" && !isEscalated) {
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
              await supabase
                .schema("messaging").from("conversations")
                .update({
                  escalation_type: parsed.escalation_type,
                  lead_priority: parsed.lead_priority,
                })
                .eq("id", conversation.id);
            }

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

            if (effectiveCode !== "IGNORE") {
              const justExceeded = await incrementUsage(supabase, organizationId);
              if (justExceeded) {
                handleLimitExceeded(supabase, organizationId).catch((e) =>
                  console.error("handleLimitExceeded error:", e.message)
                );
              }
            }

            send({
              type: "done",
              message: responseText,
              quickReplies: [],
              escalated: willEscalate,
              sessionId,
            });
          } catch (e) {
            console.error("widget-chat stream error:", (e as Error)?.message);
            send({ type: "error", error: "Something went wrong. Please try again." });
          }
          controller.close();
        },
      });
      return new Response(streamBody, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": allowedOrigin,
          "Vary": "Origin",
        },
      });
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
            businessTimezone, bName, customerTimezone
          );
        } else if (calendlyIntegration) {
          result = await executeCalendlyTool(
            supabase, calendlyIntegration, toolName, toolInput,
            customerTimezone
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

    const tokensUsed = totalInputTokens + totalOutputTokens;
    const costEstimate =
      (totalInputTokens - totalCachedTokens) * KIMI_COST_INPUT +
      totalCachedTokens * KIMI_COST_CACHED_INPUT +
      totalOutputTokens * KIMI_COST_OUTPUT;

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
        ai_model: KIMI_MODEL,
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

// ── Helper: Load the org's entire knowledge base ──
// All chunks are injected into the system prompt (K2.6 256K context + Telnyx
// prompt caching make a retrieval pre-filter unnecessary). KB_MAX_CHARS is a
// safety valve for pathologically large knowledge bases.
async function loadAllKbChunks(
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
): Promise<Array<{ content: string }>> {
  // Versioned KB (structured sections) — the AI reads through the org's
  // active_kb_version_id pointer. Every amend creates a new version.
  const { data: orgRow } = await supabase
    .schema("core").from("organizations")
    .select("active_kb_version_id")
    .eq("id", organizationId)
    .single();

  let texts: string[] = [];

  if (orgRow?.active_kb_version_id) {
    const { data: version } = await supabase
      .schema("kb").from("kb_versions")
      .select("sections")
      .eq("id", orgRow.active_kb_version_id)
      .single();
    const sections = (version?.sections as Array<{ title?: string; body?: string }>) || [];
    texts = sections.map((s) => s.title ? `## ${s.title}\n\n${s.body ?? ""}` : (s.body ?? ""));
  }
  // No active version = empty KB (orgs with legacy chunks were all migrated
  // to v1; the old kb_chunks table has been dropped).

  let total = 0;
  const result: Array<{ content: string }> = [];
  for (const text of texts) {
    if (!text) continue;
    total += text.length;
    if (total > KB_MAX_CHARS) {
      console.warn(`KB truncated at ${KB_MAX_CHARS} chars for org ${organizationId}`);
      result.push({ content: "[Note: knowledge base truncated due to size]" });
      break;
    }
    result.push({ content: text });
  }
  return result;
}

// ── Employee test chat (playground) ──────────────────────────────────────────
// Reached only via the test_mode branch in the main handler. Service-key
// authenticated (server-to-server from dashboard-api). Same org config load,
// KB injection, system prompt and Kimi call as the live path — but nothing is
// persisted and no usage/credits are consumed.
async function handleTestChat(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
): Promise<Response> {
  const auth = req.headers.get("authorization") || "";
  // Shared internal secret (function envs can hold a different-but-valid
  // service key than the project's current one — exact-match on
  // SUPABASE_SERVICE_ROLE_KEY is not reliable across functions).
  const expected = Deno.env.get("INTERNAL_FUNCTION_SECRET") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (auth !== `Bearer ${expected}`) {
    return errorResponse("Unauthorized", 401, "*");
  }

  const orgId = (body.org_id ?? body.organization_id) as string | undefined;
  const message = String(body.message ?? "").trim();
  if (!orgId || !message) return errorResponse("Missing org_id or message", 400, "*");
  if (message.length > 2000) return errorResponse("Message too long (max 2000 chars)", 400, "*");

  // Client-supplied conversation history, bounded and sanitized.
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history = (rawHistory as Array<Record<string, unknown>>)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m) => ({ role: m.role as string, content: (m.content as string).slice(0, 2000) }));

  // Same org config load as the live path
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
    .eq("id", orgId)
    .single();

  if (orgError || !org) {
    return errorResponse("Organization not found", 404, "*");
  }

  const kbChunks = await loadAllKbChunks(supabase, orgId);

  const systemPrompt = buildSystemPrompt({
    org,
    kbChunks: kbChunks ?? [],
    isStaleConversation: false,
    daysSinceLastMessage: 0,
    visitorData: undefined,
    isWebchat: true,
    // No calendar tools in test mode — booking tools perform real writes.
    calendlyConnected: false,
    googleCalendarAvailable: false,
    customerTimezone: undefined,
  });

  const kimiMessages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: message },
  ];

  // Streaming variant (body.stream === true): SSE reply instead of buffered
  // JSON. Same pipeline and guarantees — see streamTestChatResponse.
  if (body.stream === true) {
    return streamTestChatResponse(kimiMessages);
  }

  const kimiT0 = Date.now();
  const kimiResponse = await callKimiWithRetry({
    model: KIMI_MODEL,
    max_tokens: 2000,
    reasoning_effort: REASONING_EFFORT,
    messages: kimiMessages,
    tools: [SUBMIT_RESPONSE_TOOL],
    tool_choice: "required",
  });
  const kimiElapsedMs = Date.now() - kimiT0;

  const rawText = (kimiResponse.choices?.[0]?.message?.content as string) ?? "";
  const toolCalls = (kimiResponse.choices?.[0]?.message?.tool_calls ?? []) as Array<Record<string, unknown>>;
  const submitCall = toolCalls.find(
    (t) => (t.function as Record<string, unknown>)?.name === "submit_response"
  );

  const parsed: RouteParseResult = submitCall
    ? parseSubmitResponse(parseToolArguments((submitCall.function as Record<string, unknown>)?.arguments as string | undefined))
    : parseClaudeResponse(rawText);

  if (!parsed.response_text?.trim()) {
    parsed.response_text = "I've looked into that for you. Could you tell me a bit more about what you need so I can help further?";
    parsed.confidence = 0.50;
  }

  // Webchat routing parity: IGNORE never reaches a live visitor
  const responseText = parsed.code === "IGNORE"
    ? (parsed.response_text || "I'm not sure I understood that. Could you rephrase?")
    : parsed.response_text;

  return jsonResponse({
    message: responseText,
    quickReplies: [],
    escalated: parsed.code === "ESCALATE",
    confidence: parsed.confidence,
    escalation_type: parsed.escalation_type,
    lead_priority: parsed.lead_priority,
    sessionId: "test",
    // Diagnostics (test mode only) — latency + prompt-cache visibility
    debug: {
      kimi_ms: kimiElapsedMs,
      prompt_tokens: kimiResponse.usage?.prompt_tokens ?? null,
      cached_tokens: kimiResponse.usage?.prompt_tokens_details?.cached_tokens ?? null,
      completion_tokens: kimiResponse.usage?.completion_tokens ?? null,
    },
  }, 200, "*");
}

// Incrementally extracts the string value of "response_text" from a streaming
// JSON document (tool-call arguments arrive in small fragments). response_text
// is the first property of submit_response, so scanning for the key is safe.
// Decodes JSON escapes; holds back incomplete escape sequences at chunk edges.
class ResponseTextExtractor {
  private buf = "";
  private started = false;
  private closed = false;

  push(chunk: string): string {
    if (this.closed) return "";
    this.buf += chunk;
    if (!this.started) {
      const m = /"response_text"\s*:\s*"/.exec(this.buf);
      if (!m) {
        if (this.buf.length > 4096) this.buf = this.buf.slice(-256);
        return "";
      }
      this.buf = this.buf.slice(m.index + m[0].length);
      this.started = true;
    }
    let out = "";
    let i = 0;
    for (; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (c === "\\") {
        const n = this.buf[i + 1];
        if (n === undefined) break; // incomplete escape — wait for more
        if (n === "u") {
          if (i + 6 > this.buf.length) break; // \uXXXX incomplete
          out += String.fromCharCode(parseInt(this.buf.slice(i + 2, i + 6), 16));
          i += 5;
          continue;
        }
        const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (!(n in map)) break;
        out += map[n];
        i += 1; // consume the escaped char too (loop i++ moves past it)
        continue;
      }
      if (c === '"') { this.closed = true; i++; break; }
      out += c;
    }
    this.buf = this.buf.slice(i);
    return out;
  }
}

interface PumpedKimiStream {
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  content: string;
  finishReason: string | null;
  usage: { prompt_tokens: number; cached_tokens: number; completion_tokens: number };
}

// Reads one streaming Kimi call end-to-end. Assembles tool calls by index,
// extracts submit_response's response_text incrementally (forwarded via
// onResponseTextDelta as it generates), streams any plain content too, and
// captures the final usage chunk (stream_options.include_usage).
async function pumpKimiStream(
  upstream: ReadableStream<Uint8Array>,
  onResponseTextDelta: (text: string) => void,
): Promise<PumpedKimiStream> {
  const extractor = new ResponseTextExtractor();
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  let content = "";
  let finishReason: string | null = null;
  const usage = { prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 };

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let lineBuf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.usage) {
        usage.prompt_tokens = chunk.usage.prompt_tokens ?? 0;
        usage.cached_tokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage.completion_tokens = chunk.usage.completion_tokens ?? 0;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      const tcs = delta.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: "", name: "", arguments: "" };
          if (tc.id) toolCalls[idx].id = tc.id;
          const fn = tc.function;
          if (fn?.name) toolCalls[idx].name = fn.name;
          if (typeof fn?.arguments === "string") {
            toolCalls[idx].arguments += fn.arguments;
            if (toolCalls[idx].name === "submit_response") {
              const piece = extractor.push(fn.arguments);
              if (piece) onResponseTextDelta(piece);
            }
          }
        }
      } else if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        onResponseTextDelta(delta.content);
      }
    }
  }
  return { toolCalls: toolCalls.filter(Boolean), content, finishReason, usage };
}

// Streaming test chat: calls Kimi with stream:true and forwards the visible
// reply text (extracted from the submit_response tool-call arguments as they
// arrive) as Server-Sent Events: {type:"delta",text}… then one terminal
// {type:"done",message,escalated,…,debug} with routing + token usage.
// Nothing persisted, no usage consumed — same guarantees as buffered mode.
async function streamTestChatResponse(kimiMessages: Array<Record<string, unknown>>, reasoningEffort: string = REASONING_EFFORT): Promise<Response> {
  const kimiT0 = Date.now();
  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = await callKimiStream({
      model: KIMI_MODEL,
      max_tokens: 2000,
      reasoning_effort: reasoningEffort,
      messages: kimiMessages,
      tools: [SUBMIT_RESPONSE_TOOL],
      tool_choice: "required",
      stream: true,
      stream_options: { include_usage: true },
    });
  } catch (e) {
    return errorResponse(`AI upstream error: ${(e as Error)?.message ?? e}`, 502, "*");
  }

  const encoder = new TextEncoder();
  const extractor = new ResponseTextExtractor();
  let fullArgs = "";
  let fullContent = "";
  let usage: Record<string, any> | null = null;
  let ttftMs: number | null = null;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let lineBuf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lineBuf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = lineBuf.indexOf("\n")) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let chunk: any;
            try { chunk = JSON.parse(data); } catch { continue; }
            if (chunk.usage) usage = chunk.usage;
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;
            const toolCalls = delta.tool_calls;
            if (Array.isArray(toolCalls)) {
              for (const tc of toolCalls) {
                const args = tc?.function?.arguments;
                if (typeof args !== "string") continue;
                fullArgs += args;
                const piece = extractor.push(args);
                if (piece) {
                  if (ttftMs === null) ttftMs = Date.now() - kimiT0;
                  send({ type: "delta", text: piece });
                }
              }
            } else if (typeof delta.content === "string" && delta.content) {
              // Fallback: model answered in plain content instead of the tool
              fullContent += delta.content;
              if (ttftMs === null) ttftMs = Date.now() - kimiT0;
              send({ type: "delta", text: delta.content });
            }
          }
        }

        // Final routing parse — identical to the buffered path
        const parsed: RouteParseResult = fullArgs
          ? parseSubmitResponse(parseToolArguments(fullArgs))
          : parseClaudeResponse(fullContent);
        if (!parsed.response_text?.trim()) {
          parsed.response_text = "I've looked into that for you. Could you tell me a bit more about what you need so I can help further?";
          parsed.confidence = 0.50;
        }
        const responseText = parsed.code === "IGNORE"
          ? (parsed.response_text || "I'm not sure I understood that. Could you rephrase?")
          : parsed.response_text;

        send({
          type: "done",
          message: responseText,
          escalated: parsed.code === "ESCALATE",
          confidence: parsed.confidence,
          escalation_type: parsed.escalation_type,
          lead_priority: parsed.lead_priority,
          debug: {
            kimi_ms: Date.now() - kimiT0,
            ttft_ms: ttftMs,
            prompt_tokens: usage?.prompt_tokens ?? null,
            cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
            completion_tokens: usage?.completion_tokens ?? null,
          },
        });
      } catch (e) {
        send({ type: "error", error: String((e as Error)?.message ?? e) });
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
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
    prompt += `\n\n## Knowledge Base\n${kbText}`;
  }

  // Routing rules (static per org — kept inside the cacheable prefix)
  const routingRules = (org.routing_rules as string) || DEFAULT_ROUTING_RULES;
  prompt += `\n\n## Routing Rules\n${routingRules}`;

  // Webchat-specific instruction — responses should be conversational and concise
  prompt += `\n\n## Channel\nYou are responding via a live website chat widget. ` +
    `Keep responses concise (2-4 sentences). ` +
    `The visitor expects an immediate reply — be warm and direct.`;

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
      `Treat new messages as a fresh inquiry if topics have changed.`;
  }

  // Visitor context — helps Kimi personalise responses
  if (visitorData && (visitorData.name || visitorData.email)) {
    const parts = [];
    if (visitorData.name) parts.push(`Name: ${visitorData.name}`);
    if (visitorData.email) parts.push(`Email: ${visitorData.email}`);
    if (visitorData.phone) parts.push(`Phone: ${visitorData.phone}`);
    prompt += `\n\n## Visitor Info\n${parts.join("\n")}`;
  }

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
// Credit pools: each service burns its pool at its own credit_cost (webchat = 1
// per exchange). See migration 20260915000000_credit_pools.sql.

// Check if the pool backing webchat is exhausted.
async function checkUsageLimit(
  supabase: ReturnType<typeof createClient>,
  organizationId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_pool_exceeded", {
    p_org: organizationId,
    p_service: "webchat",
  });
  if (error) {
    console.error("Usage limit check failed:", error.message);
    return false; // Fail open
  }
  return data === true;
}

// Burn credits after a successful AI exchange.
// Returns true if this call exhausted the pool.
async function incrementUsage(
  supabase: ReturnType<typeof createClient>,
  organizationId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc("increment_pool_usage", {
    p_org: organizationId,
    p_service: "webchat",
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

// Streaming variant of callKimiWithRetry — same retry policy, but only until
// response headers arrive; once the SSE stream starts it cannot be retried.
// Returns the raw response body stream for the caller to parse.
async function callKimiStream(params: Record<string, unknown>): Promise<ReadableStream<Uint8Array>> {
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
      if (!res.body) throw new Error("Telnyx returned no stream body");
      return res.body;
    } catch (err: any) {
      lastError = err;
      const status = err?.status;
      const retryable = status === undefined || status === 429 || status === 500 ||
        status === 502 || status === 503 || status === 504;
      if (!retryable || attempt === 2) throw err;
      console.warn(`Kimi stream failed with ${status ?? "network error"}, retrying in ${delays[attempt]}ms (attempt ${attempt + 1}/3)`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastError;
}
