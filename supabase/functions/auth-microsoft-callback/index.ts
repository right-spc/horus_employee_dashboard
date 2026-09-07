// ============================================
// EDGE FUNCTION: auth-microsoft-callback
// Handles the OAuth redirect from Microsoft,
// exchanges the code for tokens, registers a
// Microsoft Graph change notification subscription
// (equivalent of Gmail Push watch), and stores
// encrypted credentials in email_providers.
// ============================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const encoder = new TextEncoder();

async function getKey(secret: string): Promise<CryptoKey> {
  const keyData = encoder.encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  return await crypto.subtle.importKey(
    "raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]
  );
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

// ── Register Microsoft Graph change notification subscription ─────────────────
// Equivalent of Gmail's watch — tells Microsoft to POST to our webhook
// whenever a new message arrives in the inbox.
// Subscriptions expire after 3 days max and must be renewed by a cron.
async function registerGraphSubscription(
  accessToken: string,
  notificationUrl: string
): Promise<{ id: string; expirationDateTime: string }> {
  // Expiry: 3 days from now (Microsoft's maximum for mail subscriptions)
  const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const response = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl,
      resource: "me/mailFolders('Inbox')/messages",
      expirationDateTime: expiry,
      // clientState is echoed back in every notification so we can verify origin
      clientState: Deno.env.get("MICROSOFT_WEBHOOK_SECRET") ?? "horus-desk",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to register Graph subscription: ${err}`);
  }

  return await response.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const successPage = (email: string) => new Response(
    `\u2713 Outlook Connected Successfully\n\nHorus Desk can now send and receive emails from ${email}.\n\nYou can close this tab.`,
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );

  const errorPage = (message: string) => new Response(
    `\u2717 Connection Failed\n\n${message}`,
    { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    if (error) {
      throw new Error(`OAuth error: ${error} — ${errorDescription ?? ""}`);
    }

    if (!code || !state) {
      throw new Error("Missing code or state parameter");
    }

    // Parse state
    const { org_id } = JSON.parse(atob(state));
    if (!org_id) throw new Error("Invalid state parameter");

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const tokenEncryptionKey = Deno.env.get("TOKEN_ENCRYPTION_KEY");
    const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
    const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");

    if (!supabaseUrl || !serviceKey || !tokenEncryptionKey || !clientId || !clientSecret) {
      throw new Error("Missing required environment variables");
    }

    console.log("Organization ID:", org_id);

    const supabase = createClient(supabaseUrl, serviceKey);
    const encryptionKey = await getKey(tokenEncryptionKey);

    const redirectUri = `${supabaseUrl}/functions/v1/auth-microsoft-callback`;

    // ── Exchange code for tokens ──────────────
    const tokenResponse = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      }
    );

    if (!tokenResponse.ok) {
      const err = await tokenResponse.text();
      console.error("Token exchange failed:", err);
      throw new Error(`Token exchange failed: ${err}`);
    }

    const tokens = await tokenResponse.json();
    console.log("Got tokens (refresh_token exists):", !!tokens.refresh_token);

    if (!tokens.refresh_token) {
      throw new Error(
        "No refresh token received. Revoke app access at https://account.microsoft.com/permissions and try again."
      );
    }

    // ── Get user info via Microsoft Graph ─────
    const userInfoResponse = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      throw new Error("Failed to get user info from Microsoft Graph");
    }

    const userInfo = await userInfoResponse.json();
    const userEmail = userInfo.mail ?? userInfo.userPrincipalName;
    console.log("User email:", userEmail);

    if (!userEmail) {
      throw new Error("Could not determine email address from Microsoft account");
    }

    // ── Register Graph change notification subscription ───────────────────────
    // Our handle-inbound-email endpoint receives these notifications.
    // Microsoft requires this URL to respond to a validation challenge.
    const notificationUrl = `${supabaseUrl}/functions/v1/handle-inbound-email`;
    console.log("Registering Graph subscription...");
    const subscription = await registerGraphSubscription(tokens.access_token, notificationUrl);
    console.log("Subscription registered. ID:", subscription.id, "Expires:", subscription.expirationDateTime);

    // ── Encrypt tokens ────────────────────────
    const [encryptedRefresh, encryptedAccess] = await Promise.all([
      encrypt(tokens.refresh_token, encryptionKey),
      encrypt(tokens.access_token, encryptionKey),
    ]);

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // Microsoft 365 accounts have higher limits than personal Outlook.com
    const isPersonal = userEmail.endsWith("@outlook.com") ||
      userEmail.endsWith("@hotmail.com") ||
      userEmail.endsWith("@live.com");
    const dailyLimit = isPersonal ? 300 : 1000;

    // ── Upsert email_providers record ─────────
    const { data: existing, error: fetchError } = await supabase
      .from("email_providers")
      .select("id")
      .eq("organization_id", org_id)
      .eq("provider", "microsoft")
      .maybeSingle();

    if (fetchError) {
      throw new Error(`Database fetch failed: ${fetchError.message}`);
    }

    console.log("Existing record found:", !!existing);

    let dbError;

    if (existing) {
      console.log("Updating existing record...");
      const { error } = await supabase
        .from("email_providers")
        .update({
          status: "active",
          refresh_token_encrypted: encryptedRefresh,
          access_token_encrypted: encryptedAccess,
          token_expires_at: expiresAt,
          provider_account_email: userEmail,
          provider_account_id: userInfo.id,
          // Reuse last_history_id to store the Graph subscription ID
          // watch_expiry tracks when this subscription expires (3 days)
          last_history_id: subscription.id,
          watch_expiry: subscription.expirationDateTime,
          daily_send_limit: dailyLimit,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      dbError = error;
    } else {
      console.log("Inserting new record...");
      const { error } = await supabase
        .from("email_providers")
        .insert({
          organization_id: org_id,
          provider: "microsoft",
          status: "active",
          refresh_token_encrypted: encryptedRefresh,
          access_token_encrypted: encryptedAccess,
          token_expires_at: expiresAt,
          provider_account_email: userEmail,
          provider_account_id: userInfo.id,
          last_history_id: subscription.id,
          watch_expiry: subscription.expirationDateTime,
          daily_send_limit: dailyLimit,
          emails_sent_today: 0,
          last_reset_date: new Date().toISOString().split("T")[0],
        });
      dbError = error;
    }

    if (dbError) {
      console.error("Database error:", dbError);
      throw new Error(`Failed to save credentials: ${dbError.message}`);
    }

    console.log("Database save successful");

    return successPage(userEmail);

  } catch (error) {
    console.error("OAuth callback error:", error);
    return errorPage(error.message);
  }
});
