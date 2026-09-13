-- Voice calls: recording + transcript storage (correction to 20260917000000).
-- Owner clarification: calls ARE recorded and transcribed — the privacy rule only
-- means EMPLOYEES can't access them via the dashboard. The structural guard stays:
-- no core bridge view for voice.calls, so PostgREST has no path to raw rows.
-- Transcripts themselves land in messaging.messages via conversation_id (channel
-- 'voice') — visible in the CUSTOMER's inbox, same as chat/email.

BEGIN;

ALTER TABLE voice.calls ADD COLUMN recording_url text;

COMMENT ON COLUMN voice.calls.recording_url IS
  'Telnyx recording URL. Internal only — never exposed to employees (no core view; aggregates-only RPC).';

-- Per-org recording toggle (plan §legal: 2-party-consent states → default ON with
-- greeting disclosure; org can switch off).
ALTER TABLE voice.configs ADD COLUMN recording_enabled boolean NOT NULL DEFAULT true;

-- Bridge views capture SELECT * at creation time — new columns do NOT propagate.
-- Recreate so core.voice_configs exposes recording_enabled. (voice.calls has no
-- bridge view by design, so recording_url needs no view change.)
CREATE OR REPLACE VIEW core.voice_configs WITH (security_invoker = true) AS SELECT * FROM voice.configs;
GRANT ALL ON core.voice_configs TO service_role, authenticated, anon;

COMMIT;
