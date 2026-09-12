// ============================================
// EDGE FUNCTION: widget-config
// Public endpoint — no JWT required.
// Returns widget configuration for a given API key.
// Called by the widget on load and every 60 seconds.
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const url = new URL(req.url);
    const apiKey = url.searchParams.get("apiKey") ||
      req.headers.get("X-API-Key");

    if (!apiKey) {
      return jsonResponse({ error: "Missing apiKey" }, 400, "*");
    }

    // Look up widget config by API key
    const { data: config, error } = await supabase
      .schema("core").from("widget_configs")
      .select(`
        enabled,
        disable_reason,
        disable_message,
        header_title,
        welcome_message,
        position,
        auto_open,
        auto_open_delay_ms,
        show_powered_by,
        capture_fields,
        required_fields,
        form_title,
        form_subtitle,
        colors,
        allowed_domains,
        organization_id
      `)
      .eq("api_key", apiKey)
      .single();

    if (error || !config) {
      // Return disabled state rather than 404 — prevents leaking whether a key exists
      return jsonResponse({
        enabled: false,
        disableReason: "invalid_key",
        disableMessage: "Chat is currently unavailable.",
        retryAfter: 300,
      }, 200, "*");
    }

    // Determine allowed origin for CORS
    const origin = req.headers.get("origin") ?? "*";
    const allowedOrigin = getAllowedOrigin(origin, config.allowed_domains);

    // Org logo (branding for the widget header + AI avatar)
    const { data: orgRow } = await supabase
      .schema("core").from("organizations")
      .select("logo_url")
      .eq("id", config.organization_id)
      .single();

    // If widget is disabled, return minimal response
    if (!config.enabled) {
      return jsonResponse({
        enabled: false,
        disableReason: config.disable_reason ?? null,
        disableMessage: config.disable_message ?? "Chat is temporarily unavailable.",
        retryAfter: 300,
      }, 200, allowedOrigin);
    }

    // Return full config — strip internal fields
    return jsonResponse({
      enabled: true,
      disableReason: null,
      disableMessage: null,
      retryAfter: 60,

      // UI
      headerTitle: config.header_title,
      welcomeMessage: config.welcome_message,
      position: config.position,
      autoOpen: config.auto_open,
      autoOpenDelay: config.auto_open_delay_ms,
      showPoweredBy: config.show_powered_by,
      logoUrl: orgRow?.logo_url ?? null,

      // Pre-chat form
      captureFields: config.capture_fields ?? [],
      requiredFields: config.required_fields ?? [],
      formTitle: config.form_title,
      formSubtitle: config.form_subtitle,

      // Theme
      colors: config.colors ?? {
        light: {
          headerBg: "#2563eb", headerText: "#ffffff",
          userBubble: "#2563eb", userText: "#ffffff",
          aiBubble: "#f3f4f6", aiText: "#1f2937",
          bg: "#ffffff", inputBg: "#ffffff", inputText: "#1f2937",
          sendBtn: "#2563eb", sendBtnText: "#ffffff",
        },
        dark: {
          headerBg: "#1e40af", headerText: "#ffffff",
          userBubble: "#3b82f6", userText: "#ffffff",
          aiBubble: "#374151", aiText: "#f9fafb",
          bg: "#111827", inputBg: "#1f2937", inputText: "#f9fafb",
          sendBtn: "#3b82f6", sendBtnText: "#ffffff",
        },
      },
    }, 200, allowedOrigin);

  } catch (err) {
    console.error("widget-config error:", err);
    return jsonResponse({ error: "Internal server error" }, 500, "*");
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(
  data: unknown,
  status: number,
  allowedOrigin: string
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": allowedOrigin,
      "Vary": "Origin",
      // Per-client cache only — shared caches can't key on Origin safely.
      "Cache-Control": "private, max-age=60",
    },
  });
}

function getAllowedOrigin(origin: string, allowedDomains: string[]): string {
  // Empty allowed_domains = allow all (development mode)
  if (!allowedDomains || allowedDomains.length === 0) return "*";

  // Check if the request origin matches any allowed domain
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
