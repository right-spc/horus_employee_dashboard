-- TEMPORARY debug table for voice webhook troubleshooting (silence on test line).
-- Captures every inbound Telnyx event + action errors since function console
-- logs are not delivered via the logs analytics endpoint for this project.
-- Drop once Phase 1 E2E is verified.
CREATE TABLE IF NOT EXISTS voice.webhook_debug (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  event_type  text,
  call_control_id text,
  direction   text,
  payload     jsonb,
  error       text
);

GRANT SELECT, INSERT ON voice.webhook_debug TO service_role;
