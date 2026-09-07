// ============================================
// EDGE FUNCTION: widget-survey
// Public endpoint — no JWT required.
// Receives end-of-chat survey submissions
// from the widget and stores them.
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key, X-Widget-Version",
};

Deno.serve(async (req: Request) => {
  // ── CORS preflight ────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...CORS_HEADERS, "Access-Control-Allow-Origin": "*" },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, "*");
  }

  const { apiKey, sessionId, helpfulRating, understandRating, couldResolveWithoutHuman, comment } = body as {
    apiKey: string;
    sessionId: string;
    helpfulRating?: number;
    understandRating?: number;
    couldResolveWithoutHuman?: boolean;
    comment?: string;
  };

  if (!apiKey || !sessionId) {
    return jsonResponse({ error: "Missing required fields: apiKey, sessionId" }, 400, "*");
  }

  // ── Validate API key ──────────────────────
  const { data: widgetConfig, error: configError } = await supabase
    .schema("core").from("widget_configs")
    .select("organization_id, allowed_domains")
    .eq("api_key", apiKey)
    .single();

  if (configError || !widgetConfig) {
    return jsonResponse({ error: "Invalid API key" }, 401, "*");
  }

  const origin = req.headers.get("origin") ?? "*";
  const allowedOrigin = getAllowedOrigin(origin, widgetConfig.allowed_domains);
  const organizationId = widgetConfig.organization_id;

  // ── Look up conversation by sessionId ─────
  // sessionId is stored as external_thread_id on webchat conversations
  const { data: conversation } = await supabase
    .schema("messaging").from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("channel", "webchat")
    .eq("external_thread_id", sessionId)
    .maybeSingle();

  // ── Save survey ───────────────────────────
  const { error: surveyError } = await supabase
    .schema("messaging").from("widget_surveys")
    .insert({
      organization_id: organizationId,
      conversation_id: conversation?.id ?? null,
      session_id: sessionId,
      helpful_rating: helpfulRating ?? null,
      understand_rating: understandRating ?? null,
      could_resolve_without_human: couldResolveWithoutHuman ?? null,
      comment: typeof comment === "string" && comment.trim().length > 0
        ? comment.trim().slice(0, 1000)
        : null,
    });

  if (surveyError) {
    console.error("widget-survey insert error:", surveyError);
    return jsonResponse({ error: "Failed to save survey" }, 500, allowedOrigin);
  }

  return jsonResponse({ success: true }, 200, allowedOrigin);
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
