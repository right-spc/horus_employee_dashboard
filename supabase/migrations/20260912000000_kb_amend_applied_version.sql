-- KB redesign Phase 2: link amend requests to the version they produced.
-- Per docs/client-rbac-plan.md §5.1. Additive only.

BEGIN;

ALTER TABLE kb.kb_amend_requests
  ADD COLUMN IF NOT EXISTS applied_version_id uuid REFERENCES kb.kb_versions(id) ON DELETE SET NULL;

COMMIT;
