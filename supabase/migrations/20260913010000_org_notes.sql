-- ── Org account notes ────────────────────────────────────────────────────────
-- Employee-written history entries on an organization (account history /
-- notes tracker shown on the Overview tab). Append-friendly, nothing fancy.

CREATE TABLE IF NOT EXISTS core.org_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_by uuid REFERENCES core.dashboard_users(id) ON DELETE SET NULL,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_notes_org_idx ON core.org_notes (organization_id, created_at DESC);

GRANT ALL ON core.org_notes TO service_role, authenticated, anon;
