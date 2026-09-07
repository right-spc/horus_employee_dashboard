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

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
    if (!clientId || !clientSecret) throw new Error("Missing Google OAuth credentials");

    // Exchange code for tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${supabaseUrl}/functions/v1/auth-google-calendar-callback`,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error("Google token exchange failed:", errorData);
      throw new Error(`Token exchange failed: ${errorData}`);
    }

    const tokens = await tokenResponse.json();
    console.log("Got Google tokens (refresh_token exists):", !!tokens.refresh_token);

    if (!tokens.refresh_token) {
      throw new Error(
        "No refresh token received. The user may have already authorized this app. " +
        "Revoke access at https://myaccount.google.com/permissions and try again."
      );
    }

    // Get account email
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      const uiError = await userInfoResponse.text();
      console.error("Google userinfo failed:", userInfoResponse.status, uiError);
      throw new Error(`Failed to get Google user info: ${userInfoResponse.status}`);
    }

    const userInfo = await userInfoResponse.json();
    const accountEmail = userInfo.email;
    console.log("Google Calendar account:", accountEmail);

    // Fetch calendar list
    const calendarListResponse = await fetch(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );

    let calendars: Array<{ id: string; summary: string; primary: boolean }> = [];
    if (calendarListResponse.ok) {
      const calData = await calendarListResponse.json();
      calendars = (calData.items || []).map((cal: any) => ({
        id: cal.id,
        summary: cal.summary || cal.id,
        primary: !!cal.primary,
      }));
      console.log(`Found ${calendars.length} writable calendars`);
    } else {
      console.warn("Failed to fetch calendar list, will be populated on first use");
    }

    // Encrypt credentials
    const credentialsJson = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    });
    const encryptedCredentials = await encrypt(credentialsJson, encryptionKey);
    const expiresAt = new Date(
      Date.now() + (tokens.expires_in || 3600) * 1000
    ).toISOString();

    // Upsert into integrations table
    const { data: existing } = await supabase
      .schema("comms")
      .from("integrations")
      .eq("organization_id", org_id)
      .eq("integration_type", "google_calendar")
      .maybeSingle();

    const integrationData = {
      organization_id: org_id,
      integration_type: "google_calendar",
      name: "Google Calendar",
      status: "active",
      credentials_encrypted: encryptedCredentials,
      credentials_expires_at: expiresAt,
      config: {
        account_email: accountEmail,
        selected_calendar_id: null,
        calendars,
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
      throw new Error(`Failed to save Google Calendar credentials: ${dbError.message}`);
    }

    console.log("Google Calendar integration saved successfully for org:", org_id);

    const calendarNames = calendars.map((c) => c.summary).join(", ");
    return new Response(
      `✓ Google Calendar Connected Successfully\n\nHorus Desk can now create bookings on your Google Calendar (${accountEmail}).\n\n${calendars.length} writable calendar(s) found: ${calendarNames}\n\nYou can close this tab.`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  } catch (error) {
    console.error("Google Calendar OAuth callback error:", error);
    return new Response(
      `✗ Google Calendar Connection Failed\n\n${error.message}`,
      { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
});
