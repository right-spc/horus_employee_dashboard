import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { organization_id } = await req.json();

    if (!organization_id) {
      throw new Error('organization_id required');
    }

    const clientId = Deno.env.get('CALENDLY_CLIENT_ID');
    if (!clientId) throw new Error('CALENDLY_CLIENT_ID secret is not configured');

    const redirectUri = `${Deno.env.get('SUPABASE_URL')}/functions/v1/auth-calendly-callback`;

    const state = btoa(JSON.stringify({
      org_id: organization_id,
      ts: Date.now()
    }));

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state: state,
    });

    const authUrl = `https://auth.calendly.com/oauth/authorize?${params.toString()}`;

    return new Response(
      JSON.stringify({ url: authUrl }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
