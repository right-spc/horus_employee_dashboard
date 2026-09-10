-- Multi-client foundation: clients, memberships, org linkage
-- Approved by owner 2026-09-08. Additive only: nothing dropped, existing orgs untouched.
--
-- Model:
--   core.clients          = the entity we have the relationship with (owner_id = user in full control)
--   core.client_members   = user -> client grants (cascade to all client orgs)
--   core.organization_members (existing) = user -> single-org grants
--   core.organizations.client_id = org belongs to client (nullable; NULL = unassigned)
-- Access resolution (portal): orgs = direct organization_members
--   ∪ orgs via client_members ∪ orgs via clients.owner_id.
-- core.customer_users.organization_id is DEPRECATED from this point (keep column, stop reading).

BEGIN;

-- ── 1. Clients (the entity we have the relationship with) ──────────────────
CREATE TABLE IF NOT EXISTS core.clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  owner_id    uuid REFERENCES core.customer_users(id) ON DELETE SET NULL,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Client memberships (user -> client, cascades to all client orgs) ────
CREATE TABLE IF NOT EXISTS core.client_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES core.clients(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES core.customer_users(id) ON DELETE CASCADE,
  email       text NOT NULL,               -- denormalized, same pattern as organization_members
  role        text NOT NULL DEFAULT 'manager',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, user_id)
);

-- ── 3. Link orgs to clients ────────────────────────────────────────────────
ALTER TABLE core.organizations
  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES core.clients(id) ON DELETE SET NULL;

-- ── 4. Indexes ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_clients_owner          ON core.clients(owner_id);
CREATE INDEX IF NOT EXISTS idx_client_members_client  ON core.client_members(client_id);
CREATE INDEX IF NOT EXISTS idx_client_members_user    ON core.client_members(user_id);
CREATE INDEX IF NOT EXISTS idx_organizations_client   ON core.organizations(client_id);

-- ── 5. Grants (same pattern as schema reorg) ───────────────────────────────
GRANT ALL ON core.clients        TO service_role, authenticated, anon;
GRANT ALL ON core.client_members TO service_role, authenticated, anon;
-- (organizations grant already exists; core default privileges cover future tables)

COMMIT;

-- ── 6. Seed: Right SPC + both ventures (idempotent, runs outside txn) ──────
DO $$
DECLARE
  v_client uuid;
  v_user   uuid;
BEGIN
  -- Owner identity record (the single existing customer_users row)
  SELECT id INTO v_user FROM core.customer_users
  WHERE lower(email) = 'moaaz@rightspc.com' LIMIT 1;

  -- Create the client if it doesn't exist
  SELECT id INTO v_client FROM core.clients WHERE name = 'Right SPC' LIMIT 1;
  IF v_client IS NULL THEN
    INSERT INTO core.clients (name, owner_id, notes)
    VALUES ('Right SPC', v_user, 'Internal ventures')
    RETURNING id INTO v_client;
  END IF;

  -- Make owner if not already set
  UPDATE core.clients SET owner_id = v_user
  WHERE id = v_client AND owner_id IS NULL AND v_user IS NOT NULL;

  -- Link both ventures
  UPDATE core.organizations SET client_id = v_client
  WHERE client_id IS NULL AND (
    id = 'c92d3a6f-eb0d-4c5c-969e-a3076b16c4ed'        -- Horus Desk
    OR name ILIKE '%thoth%'                            -- Thoth Line
  );
END $$;
