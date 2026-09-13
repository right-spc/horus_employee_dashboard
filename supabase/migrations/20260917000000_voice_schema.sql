-- Voice channel schema — Phase 1a (docs/voice-channel-plan.md).
-- Creates the `voice` domain schema (one-domain-per-schema house pattern):
--   voice.phone_numbers  — provisioned Telnyx numbers (1 per org in v1)
--   voice.configs        — per-org AI receptionist configuration
--   voice.calls          — per-call records (billing/cost reconciliation + aggregate stats,
--                          recording_url for internal storage — see 20260917010000)
-- Privacy rule: employees NEVER see caller numbers/recordings/transcripts — only
-- aggregates. That's enforced structurally: voice.calls gets NO core bridge view,
-- so PostgREST (core-only) has no path to raw call rows. Aggregates come from a
-- server-side RPC in a later phase.
-- Also adds 'voice' to messaging.conversations.channel CHECK (calls link conversations).

BEGIN;

-- ── Schema ────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS voice;
GRANT USAGE ON SCHEMA voice TO service_role, authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA voice GRANT ALL ON TABLES TO service_role, authenticated, anon;

-- ── voice.phone_numbers ───────────────────────────────────────────────────────
CREATE TABLE voice.phone_numbers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  telnyx_number_id   text,                          -- Telnyx phone_number record id (needed to release)
  phone_number       text NOT NULL,                 -- E.164, e.g. +14155550123
  capabilities       text[] NOT NULL DEFAULT '{voice}',
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('pending', 'active', 'released', 'failed')),
  monthly_cost_cents integer NOT NULL DEFAULT 100,  -- internal cost only — bundled pricing, never shown to clients
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id),                         -- v1: one number per org
  UNIQUE (phone_number)
);

-- ── voice.configs ─────────────────────────────────────────────────────────────
-- Per-org receptionist config. Writes here mark the assistant out-of-sync;
-- the sync worker pushes to Telnyx and stamps instructions_version + synced_at.
CREATE TABLE voice.configs (
  organization_id      uuid PRIMARY KEY REFERENCES core.organizations(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  telnyx_assistant_id  text,
  tts_voice            text NOT NULL DEFAULT 'Telnyx.Ultra.1242fb95-7ddd-44ac-8a05-9e8a22a6137d',  -- Cindy
  greeting_text        text NOT NULL DEFAULT 'Thank you for calling! How can I help you today?',
  transfer_enabled     boolean NOT NULL DEFAULT false,
  transfer_number      text,
  fallback_mode        text NOT NULL DEFAULT 'voicemail'
                       CHECK (fallback_mode IN ('voicemail', 'forward')),
  fallback_number      text,
  voicemail_greeting   text NOT NULL DEFAULT 'Sorry, we''re unable to take your call right now. Please leave a message after the tone.',
  after_hours_mode     text NOT NULL DEFAULT 'fallback'
                       CHECK (after_hours_mode IN ('answer', 'fallback')),
  instructions_version integer,                     -- KB/prompt version last synced to the assistant
  synced_at            timestamptz,                 -- last successful push to Telnyx
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT transfer_enabled OR transfer_number IS NOT NULL),
  CHECK (fallback_mode <> 'forward' OR fallback_number IS NOT NULL)
);

-- ── voice.calls ───────────────────────────────────────────────────────────────
-- recording_url added in 20260917010000 (calls ARE recorded/transcribed —
-- employees just can't reach them: no core bridge view, aggregates-only RPC).
CREATE TABLE voice.calls (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  conversation_id        uuid REFERENCES messaging.conversations(id) ON DELETE SET NULL,
  telnyx_call_control_id text UNIQUE,               -- call leg id → idempotent webhook upserts
  direction              text NOT NULL DEFAULT 'inbound'
                         CHECK (direction IN ('inbound', 'outbound')),
  from_number            text NOT NULL,
  to_number              text NOT NULL,
  assistant_id           text,
  answered_at            timestamptz,
  ended_at               timestamptz,
  duration_seconds       integer NOT NULL DEFAULT 0,
  engine_minutes         numeric(10,2) NOT NULL DEFAULT 0,  -- billed Telnyx AI engine minutes
  llm_input_tokens       integer,
  llm_output_tokens      integer,
  cost_usd               numeric(10,4),
  outcome                text CHECK (outcome IN ('completed', 'transferred', 'message_taken',
                                                 'abandoned', 'voicemail', 'forwarded')),
  hangup_reason          text,
  credits_charged        integer NOT NULL DEFAULT 0,        -- credits burned from the shared pool
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_calls_org_created ON voice.calls (organization_id, created_at DESC);

-- ── RLS (same org-isolation pattern as every domain table) ────────────────────
ALTER TABLE voice.phone_numbers ENABLE ROW LEVEL SECURITY;
CREATE POLICY phone_number_isolation ON voice.phone_numbers
  USING (organization_id = auth_org_id());

ALTER TABLE voice.configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY voice_config_isolation ON voice.configs
  USING (organization_id = auth_org_id());

ALTER TABLE voice.calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY call_isolation ON voice.calls
  USING (organization_id = auth_org_id());

-- ── core bridge views (PostgREST path) — configs + phone_numbers ONLY ─────────
CREATE VIEW core.phone_numbers WITH (security_invoker = true) AS SELECT * FROM voice.phone_numbers;
CREATE VIEW core.voice_configs WITH (security_invoker = true) AS SELECT * FROM voice.configs;
GRANT ALL ON core.phone_numbers TO service_role, authenticated, anon;
GRANT ALL ON core.voice_configs TO service_role, authenticated, anon;

-- ── conversations.channel: allow 'voice' ──────────────────────────────────────
ALTER TABLE messaging.conversations DROP CONSTRAINT conversations_channel_check;
ALTER TABLE messaging.conversations ADD CONSTRAINT conversations_channel_check
  CHECK (channel = ANY (ARRAY['email', 'webchat', 'whatsapp', 'facebook', 'sms', 'rcs', 'api', 'voice']));

COMMIT;
