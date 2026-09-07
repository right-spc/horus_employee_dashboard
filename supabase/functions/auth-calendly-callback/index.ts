import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const encoder = new TextEncoder();

async function getKey(secret: string) {
  const keyData = encoder.encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  return await crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encrypt(text: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(text)
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      throw new Error(`OAuth error: ${error}`);
    }

    if (!code || !state) {
      throw new Error("Missing code or state");
    }

    const { org_id } = JSON.parse(atob(state));
    if (!org_id) throw new Error("Invalid state parameter");

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) throw new Error("Missing environment variables");

    const supabase = createClient(supabaseUrl, serviceKey);

    const tokenEncryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY");
    if (!tokenEncryptionKey) throw new Error("Missing TOKEN_ENCRYPTION_KEY");
    const encryptionKey = await getKey(tokenEncryptionKey);

    const clientId = Deno.env.get("CALENDLY_CLIENT_ID");
    const clientSecret = Deno.env.get("CALENDLY_CLIENT_SECRET");
    if (!clientId || !clientSecret) throw new Error("Missing Calendly OAuth credentials");

    // Exchange code for tokens
    const tokenResponse = await fetch("https://auth.calendly.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${supabaseUrl}/functions/v1/auth-calendly-callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error("Calendly token exchange failed:", errorData);
      throw new Error(`Token exchange failed: ${errorData}`);
    }

    const tokens = await tokenResponse.json();
    console.log("Got Calendly tokens (refresh_token exists):", !!tokens.refresh_token);

    if (!tokens.refresh_token) {
      throw new Error("No refresh token received from Calendly.");
    }

    // Get current user info (needed for API calls)
    const meResponse = await fetch("https://api.calendly.com/users/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!meResponse.ok) {
      const meError = await meResponse.text();
      console.error("Calendly /users/me failed:", meResponse.status, meError);
      throw new Error(`Failed to get Calendly user info: ${meResponse.status}`);
    }

    const meData = await meResponse.json();
    const userUri = meData.resource.uri;
    const userName = meData.resource.name;
    const orgUri = meData.resource.current_organization;
    console.log("Calendly user:", userName, "URI:", userUri);

    // Fetch active event types
    const eventTypesResponse = await fetch(
      `https://api.calendly.com/event_types?user=${encodeURIComponent(userUri)}&active=true&count=25`,
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );

    let eventTypes: Array<{ uri: string; name: string; duration: number; slug: string }> = [];
    if (eventTypesResponse.ok) {
      const etData = await eventTypesResponse.json();
      eventTypes = (etData.collection || []).map((et: any) => ({
        uri: et.uri,
        name: et.name,
        duration: et.duration,
        slug: et.slug,
      }));
      console.log(`Found ${eventTypes.length} active event types`);
    } else {
      console.warn("Failed to fetch event types, will be populated on first use");
    }

    // Encrypt tokens
    const credentialsJson = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    });
    const encryptedCredentials = await encrypt(credentialsJson, encryptionKey);
    const expiresAt = new Date(
      Date.now() + (tokens.expires_in || 7200) * 1000
    ).toISOString();

    // Upsert into integrations table
    const { data: existing } = await supabase
      .schema("comms")
      .from("integrations")
      .eq("organization_id", org_id)
      .eq("integration_type", "calendly")
      .maybeSingle();

    const integrationData = {
      organization_id: org_id,
      integration_type: "calendly",
      name: "Calendly",
      status: "active",
      credentials_encrypted: encryptedCredentials,
      credentials_expires_at: expiresAt,
      config: {
        calendly_user_uri: userUri,
        calendly_user_name: userName,
        calendly_org_uri: orgUri,
        event_types: eventTypes,
      },
      error_count: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    };

    let dbError;
    if (existing) {
      const { error } = await supabase
        .schema("comms")
        .from("integrations")
        .update(integrationData)
        .eq("id", existing.id);
      dbError = error;
    } else {
      const { error } = await supabase
        .schema("comms")
        .from("integrations")
        .insert(integrationData);
      dbError = error;
    }

    if (dbError) {
      console.error("Database error:", dbError);
      throw new Error(`Failed to save Calendly credentials: ${dbError.message}`);
    }

    console.log("Calendly integration saved successfully for org:", org_id);

    return new Response(
      `✓ Calendly Connected Successfully\n\nHorus Desk can now check availability and create booking links using your Calendly account (${userName}).\n\n${eventTypes.length} event type(s) found: ${eventTypes.map((e) => e.name).join(", ")}\n\nYou can close this tab.`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  } catch (error) {
    console.error("Calendly OAuth callback error:", error);
    return new Response(
      `✗ Calendly Connection Failed\n\n${error.message}`,
      { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
});
