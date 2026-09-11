-- KB redesign Phase 2 cleanup: retire the chunked-KB tables.
-- Per docs/client-rbac-plan.md §5.2 step 5 — apply ONLY after the versioned KB
-- pipeline is verified live (chat + email answers, sections editor, rollback).
--
-- Backup note: all content already lives in kb.kb_versions (v1 = full
-- migration snapshot, source='migration'), so dropping these loses nothing.

BEGIN;

-- document_id on amend requests is obsolete (whole-KB model) — drop it first
-- (its FK depends on kb_documents)
ALTER TABLE kb.kb_amend_requests DROP COLUMN IF EXISTS document_id;

DROP TABLE IF EXISTS kb.kb_chunks;
DROP TABLE IF EXISTS kb.kb_documents;

COMMIT;
