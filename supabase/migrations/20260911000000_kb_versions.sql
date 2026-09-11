-- KB redesign Phase 1: immutable, whole-KB versions with structured sections.
-- Per docs/client-rbac-plan.md §5. Additive-first: kb_documents/kb_chunks are
-- RETIRED but kept (rows intact) as backup until Phase 2 verifies live behavior.
--
-- Model:
--   kb.kb_versions                       = append-only KB history (sections jsonb)
--   core.organizations.active_kb_version_id = pointer the AI reads through
-- Rules: nothing edited in place; amend = new version + pointer moves;
-- rollback = new version copying old content.

BEGIN;

-- ── 1. KB versions table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kb.kb_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  version         int NOT NULL,
  sections        jsonb NOT NULL DEFAULT '[]',   -- [{title, body}, ...]
  change_summary  text,
  source          text NOT NULL DEFAULT 'dashboard',  -- dashboard | customer_amend | template | migration
  created_by      uuid,
  created_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, version)
);

-- ── 2. Active-version pointer on the org ─────────────────────────────────────
ALTER TABLE core.organizations
  ADD COLUMN IF NOT EXISTS active_kb_version_id uuid REFERENCES kb.kb_versions(id) ON DELETE SET NULL;

-- ── 3. Indexes + grants ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_kb_versions_org ON kb.kb_versions(organization_id);

GRANT ALL ON kb.kb_versions TO service_role, authenticated, anon;

COMMIT;

-- ── 4. Data migration: chunks -> sections -> v1 per org (nothing dropped) ────
-- Each legacy chunk becomes one section:
--   "## Heading\nbody"  -> {title: "Heading", body: "body"}   (markdown docs)
--   "Q: ...\nA: ..."    -> {title: question,  body: "A: ..."} (FAQ docs)
--   anything else       -> {title: "",        body: content}  (paragraph chunks)
-- Ordering: document created_at, then chunk_index (doc-grouped — an improvement
-- over the old cross-document chunk_index ordering, content-complete).
DO $$
DECLARE
  v_org        RECORD;
  v_sections   jsonb;
  v_version_id uuid;
BEGIN
  FOR v_org IN
    SELECT DISTINCT d.organization_id
    FROM kb.kb_documents d
    JOIN kb.kb_chunks c ON c.document_id = d.id
  LOOP
    SELECT jsonb_agg(
             jsonb_build_object(
               'title',
               CASE
                 WHEN c.content ~ '^##\s'
                   THEN regexp_replace(split_part(c.content, E'\n', 1), '^##\s+', '')
                 WHEN c.content ~ '^Q:\s'
                   THEN regexp_replace(split_part(c.content, E'\n', 1), '^Q:\s+', '')
                 ELSE ''
               END,
               'body',
               CASE
                 WHEN position(E'\n' in c.content) > 0
                   AND (c.content ~ '^##\s' OR c.content ~ '^Q:\s')
                   THEN btrim(substring(c.content from position(E'\n' in c.content) + 1))
                 ELSE c.content
               END
             )
             ORDER BY d.created_at, c.chunk_index
           )
      INTO v_sections
    FROM kb.kb_chunks c
    JOIN kb.kb_documents d ON d.id = c.document_id
    WHERE d.organization_id = v_org.organization_id;

    INSERT INTO kb.kb_versions (organization_id, version, sections, change_summary, source)
    VALUES (v_org.organization_id, 1, coalesce(v_sections, '[]'::jsonb),
            'Migrated from chunked KB', 'migration')
    RETURNING id INTO v_version_id;

    UPDATE core.organizations
    SET active_kb_version_id = v_version_id
    WHERE id = v_org.organization_id;
  END LOOP;
END $$;
