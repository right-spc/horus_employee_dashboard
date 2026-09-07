// ============================================
// EDGE FUNCTION: auth-microsoft
// Generates a Microsoft OAuth authorization URL
// and returns it to the caller.
// Usage: POST with body { "organization_id": "<uuid>" }
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { organization_id } = await req.json();

    if (!organization_id) {
      throw new Error("organization_id required");
    }

    const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
    const tenantId = Deno.env.get("MICROSOFT_TENANT_ID");

    if (!clientId || !tenantId) {
      throw new Error("Missing MICROSOFT_CLIENT_ID or MICROSOFT_TENANT_ID");
    }

    const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/auth-microsoft-callback`;

    const state = btoa(JSON.stringify({
      org_id: organization_id,
      ts: Date.now(),
    }));

    // Use /common endpoint to support both personal (Outlook.com) and
    // organizational (Microsoft 365) accounts.
    // Switch to /${tenantId}/oauth2/v2.0/authorize if org-only accounts needed.
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: [
        "https://graph.microsoft.com/Mail.Read",
        "https://graph.microsoft.com/Mail.Send",
        "https://graph.microsoft.com/User.Read",
        "offline_access",
      ].join(" "),
      response_mode: "query",
      state,
      // Force consent screen so we always get a refresh token
      prompt: "consent",
    });

    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;

    return new Response(
      JSON.stringify({ url: authUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
