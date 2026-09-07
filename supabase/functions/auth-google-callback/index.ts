import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

async function registerGmailWatch(
  accessToken: string,
  topicName: string
): Promise<{ historyId: string; expiration: string }> {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/watch",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topicName,
        labelIds: ["INBOX"],
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to register Gmail watch: ${err}`);
  }

  return await response.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      throw new Error(`OAuth error: ${error}`);
    }

    if (!code || !state) {
      throw new Error('Missing code or state');
    }

    // Parse state
    const { org_id } = JSON.parse(atob(state));
    
    if (!org_id) throw new Error('Invalid state parameter');

    // DEBUG: Check env vars
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    console.log('SUPABASE_URL exists:', !!supabaseUrl);
    console.log('SUPABASE_SERVICE_ROLE_KEY exists:', !!serviceKey);
    console.log('Key starts with eyJ:', serviceKey?.startsWith('eyJ'));
    console.log('Organization ID:', org_id);

    if (!supabaseUrl || !serviceKey) {
      throw new Error('Missing environment variables');
    }

    // Initialize Supabase client
    const supabase = createClient(supabaseUrl, serviceKey);

    // Get encryption key
    const tokenEncryptionKey = Deno.env.get('TOKEN_ENCRYPTION_KEY');
    if (!tokenEncryptionKey) {
      throw new Error('Missing TOKEN_ENCRYPTION_KEY');
    }
    const encryptionKey = await getKey(tokenEncryptionKey);

    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: Deno.env.get('GOOGLE_CLIENT_ID') || '',
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') || '',
        redirect_uri: `${supabaseUrl}/functions/v1/auth-google-callback`,
        grant_type: 'authorization_code'
      })
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('Token exchange failed:', errorData);
      throw new Error(`Token exchange failed: ${errorData}`);
    }

    const tokens = await tokenResponse.json();
    console.log('Got tokens from Google (refresh_token exists):', !!tokens.refresh_token);

    const grantedScopes = (tokens.scope || "").split(" ").filter(Boolean);
    const hasCalendarScope = grantedScopes.some((s: string) => s.includes("calendar"));
    console.log('Granted scopes:', grantedScopes, 'Calendar access:', hasCalendarScope);

    if (!tokens.refresh_token) {
      throw new Error('No refresh token received. User may have already authorized this app. Revoke access at https://myaccount.google.com/permissions and try again.');
    }

    // Get user info
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });

    if (!userInfoResponse.ok) {
      throw new Error('Failed to get user info');
    }

    const userInfo = await userInfoResponse.json();
    console.log('User email:', userInfo.email);
    const pubSubTopicName = Deno.env.get('GMAIL_PUBSUB_TOPIC');
    if (!pubSubTopicName) throw new Error('Missing GMAIL_PUBSUB_TOPIC env var');

    console.log('Registering Gmail push watch...');
    const watchResult = await registerGmailWatch(tokens.access_token, pubSubTopicName);
    console.log('Watch registered. historyId:', watchResult.historyId);
    const watchExpiry = new Date(parseInt(watchResult.expiration)).toISOString();

    // ENCRYPT tokens before storing
    const [encryptedRefresh, encryptedAccess] = await Promise.all([
      encrypt(tokens.refresh_token, encryptionKey),
      encrypt(tokens.access_token, encryptionKey),
    ]);

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const isGmail = userInfo.email.endsWith('@gmail.com');
    const dailyLimit = isGmail ? 100 : 2000;

    // Check if record exists first
    const { data: existing, error: fetchError } = await supabase
      .from('email_providers')
      .select('id')
      .eq('organization_id', org_id)
      .eq('provider', 'google')
      .maybeSingle();

    if (fetchError) {
      console.error('Fetch existing error:', fetchError);
      throw new Error(`Database fetch failed: ${fetchError.message}`);
    }

    console.log('Existing record found:', !!existing);

    let dbError;

    if (existing) {
      // Update existing
      console.log('Updating existing record...');
      const { error } = await supabase
        .from('email_providers')
        .update({
          status: 'active',
          refresh_token_encrypted: encryptedRefresh,
          access_token_encrypted: encryptedAccess,
          token_expires_at: expiresAt,
          provider_account_email: userInfo.email,
          provider_account_id: userInfo.id,
          last_history_id: watchResult.historyId,
          watch_expiry: watchExpiry,
          daily_send_limit: dailyLimit,
          granted_scopes: grantedScopes,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
      dbError = error;
    } else {
      // Insert new
      console.log('Inserting new record...');
      const { error } = await supabase
        .from('email_providers')
        .insert({
          organization_id: org_id,
          provider: 'google',
          status: 'active',
          refresh_token_encrypted: encryptedRefresh,
          access_token_encrypted: encryptedAccess,
          token_expires_at: expiresAt,
          provider_account_email: userInfo.email,
          provider_account_id: userInfo.id,
          last_history_id: watchResult.historyId,
          watch_expiry: watchExpiry,
          daily_send_limit: dailyLimit,
          emails_sent_today: 0,
          last_reset_date: new Date().toISOString().split('T')[0],
          granted_scopes: grantedScopes,
        });
      dbError = error;
    }

    if (dbError) {
      console.error('Database error details:', dbError);
      throw new Error(`Failed to save credentials: ${dbError.message}`);
    }

    console.log('Database save successful');

    return new Response(
      `\u2713 Gmail Connected Successfully\n\nHorus Desk can now send and receive emails from ${userInfo.email}.${hasCalendarScope ? '\n\u2713 Google Calendar booking is enabled.' : ''}\n\nYou can close this tab.`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );

  } catch (error) {
    console.error('OAuth callback error:', error);
    return new Response(
      `\u2717 Connection Failed\n\n${error.message}`,
      { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
});