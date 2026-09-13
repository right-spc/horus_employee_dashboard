-- Voice configs: default TTS voice Cindy -> Rachel.
-- Owner curation via real test calls (Phase 0, 2026-09-13): Cindy + Kendra rejected
-- for heteronym stumbles ("live" -> "leave" etc.). Approved shortlist:
-- Rachel (10bd4af4), Reed (533b2990), Carson (4df027cb), Chase (59cb0f89).

BEGIN;

ALTER TABLE voice.configs
  ALTER COLUMN tts_voice SET DEFAULT 'Telnyx.Ultra.10bd4af4-825b-49b8-b8bd-0ca11865536e'; -- Rachel

COMMIT;
