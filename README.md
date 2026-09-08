# Horus Desk — Employee Dashboard

Internal operations dashboard for Horus Desk: organization management, demo orgs, sales pipeline, team management, and the chat-widget configuration/snippet generator.

## Stack

- **Frontend**: vanilla JS + CSS, built with Vite, deployed on Vercel (auto-deploys from `main`)
- **Backend**: Supabase (Postgres + 19 Edge Functions, sources in `supabase/functions/`)
- **AI**: Kimi K2.6 via the Telnyx Inference API (OpenAI-compatible), used by `widget-chat` and `handle-inbound-email`
- **Widget hosting**: `public/widget.js` served from `https://ctr.horusdesk.com/widget.js`

## Development

```bash
npm install
npm run dev      # vite dev server
npm run build    # build to dist/
```

## Edge Functions

Deploy with the Supabase CLI (all functions are public webhooks — always keep `--no-verify-jwt`):

```bash
npx supabase functions deploy <name> --project-ref oknqxlmyhmxbzqtnlraq --no-verify-jwt
```

## Secrets

No secrets live in this repo. `config.js` contains only public-by-design values (Supabase anon key, PayPal client ID, public widget key). All real secrets are Supabase Edge Function secrets, managed via:

```bash
npx supabase secrets list --project-ref oknqxlmyhmxbzqtnlraq
```

`.env` (local-only, gitignored) holds the Supabase access token for CLI/Management API use.
