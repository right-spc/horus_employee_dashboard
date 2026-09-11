# Horus Desk — Multi-Client RBAC & Knowledge Base Redesign Plan

> Status: **APPROVED for planning — no work started**. Build begins when the owner says go, one phase at a time.
> This document is the single source of truth for the multi-client access system, the employee RBAC, and the KB redesign. Related: `docs/voice-channel-plan.md` (SMS/voice channels land after this and build on the KB changes here).

---

## 1. What we're building

Three intertwined workstreams:

1. **Multi-client client RBAC.** Clients (commercial entities) own organizations. Customer users get access at **two tiers**: client-level (permissions span all of the client's orgs) or org-level (one org only). Roles are bundles of permissions. The employee dashboard bootstraps clients; clients will later self-manage from their own dashboard (separate repo, not built yet).
2. **Employee RBAC.** Employees stop being a hardcoded `role` text. A Softphone-style RBAC: preset-but-amendable roles, custom roles, per-employee extra grants, and **scoped visibility** (all / team / assigned). Each client has an assigned **Account Specialist** (an employee).
3. **KB redesign.** Kill the Claude-era chunking (`kb_chunks`); KB becomes full-text **structured sections**, stored **immutably versioned** — every amend creates a new version, the AI follows a pointer, history is never lost.

**Unifying principles:**
- *Version knowledge, not configuration.* KB = immutable history; business hours, AI settings, profile facts = plain in-place edits.
- *Permissions only ever add.* Union semantics everywhere — no deny rules, no overrides that subtract.
- *Two RBAC systems, never mixed.* Employee RBAC governs `dashboard_users`; client RBAC governs `customer_users`. Separate catalogs, separate tables, same pattern.

---

## 2. Decisions locked in (from brainstorm 2026-09-11)

| Decision | Choice | Rationale |
|---|---|---|
| Client membership tiers | **Two**: client-level (`core.client_members`) + org-level (`core.organization_members`) | Migration `20260908000000` anticipated this exact split |
| Conflict resolution | **Union** — permissions only ever add | Same user can be client-level Billing Manager AND org-level Leads Manager; deny-lists are a complexity trap. Matches Softphone house philosophy |
| Client RBAC model | **Full RBAC**: permissions catalog + roles (bundles) + role_permissions | Custom per-client roles later = pure data |
| Client power | **Total control over their own account** — except pricing, tiers, message limits, retention (employee-only) | Client manages their account; Right SPC manages the business terms |
| Employee access | Employees manage **everything except message/conversation content** — developer-only via DB | No `conversations:view` permission exists in the employee catalog, by design |
| Employee RBAC model | **Softphone pattern, verbatim**: preset-amendable roles, system role, custom roles, per-user extra grants (grant-only) | Proven in the Softphone project; owner-approved UX |
| Role protection tiers | `is_system` (Admin — immutable, always all permissions) > `is_preset` (editable, slug-locked, undeletable) > custom (full CRUD, undeletable while assigned) | House convention |
| Visibility scope | **Qualifier on the permission key**: `clients:view:all` / `:team` / `:assigned` (same for orgs, sales) | Scope = configuration, not code |
| Employee teams | `dashboard_users` gains team linkage so `:team` scope has meaning | "His team's accounts" must be data |
| Account Specialist | **Assignment, not a role**: `clients.account_specialist_id → dashboard_users`, always assigned (mandatory at client creation) | Every client has a go-to employee for changes/inquiries |
| KB storage | **De-chunk**: full text on the KB record; `kb_chunks` dies | Whole KB is injected into Kimi anyway — chunks buy nothing, cost complexity |
| KB versioning | **Immutable, append-only versions**; amend = new version + pointer moves; rollback = new version copying old content | History can never be lost, by construction |
| Version granularity | **Whole-KB** (one KB per org, one history) — NOT per-document | The AI consumes the whole KB as one blob |
| KB storage format | **Structured sections** (JSON: `[{title, body}]`), NOT markdown | Non-programmer editors — no hashtags. UI renders formatted; backend serializes to plain text for the AI |
| Channel readiness | Permissions **channel-agnostic** (`inbox:view` covers webchat, email, later SMS/voice) | SMS/voice add rows (channel values, `comms.phone_numbers/calls`), not RBAC structure |
| Customer portal authz | `customer-api` email-match authz **deprecated**; replaced by membership + permission checks | Old mechanism conflates alert routing with access control |

---

## 3. The client RBAC model (customers)

### 3.1 Access resolution (effective permissions for customer user U in org O)

```
perms(U, O) =   full control                          (if U = clients.owner_id of O's client)
              ∪ role perms of U's client_members row  (for O's client → cascades to ALL its orgs)
              ∪ role perms of U's organization_members row (for O specifically)
              ∪ U's per-user extra grants (if we add them client-side later)
```

### 3.2 Client permission catalog (seed; key format `resource:action`)

| Category | Permissions | Covers |
|---|---|---|
| inbox | `inbox:view`, `inbox:reply`, `inbox:manage` | Conversations across ALL channels, human takeover, star/close |
| kb | `kb:view`, `kb:manage`, `kb:amend` | Read KB; create new versions; submit amend requests |
| profile | `profile:manage` | business_profiles, services, hours, staff |
| channels | `channels:manage` | Widget config, email connection; later phone numbers / voice |
| ai | `ai:manage` | Tone, system prompt, auto-send threshold, routing rules |
| members | `members:manage` | Invite/remove users, assign roles (within the grant's tier) |
| notifications | `notifications:manage` | Recipient lists, escalation routing |
| exports | `exports:view`, `exports:manage` | Message exports, schedules, analytics |
| billing | `billing:view`, `billing:pay` | Payment history, paying invoices. NOT pricing/plans/limits |

### 3.3 Starter system roles (client side)

| Role | Scope | Permissions |
|---|---|---|
| Client Admin | client | all client-catalog permissions |
| Leads Manager | both | `inbox:*` |
| Knowledge Editor | both | `kb:view`, `kb:manage` |
| Billing Manager | both | `billing:view`, `billing:pay` |
| Viewer | both | `inbox:view`, `kb:view`, `exports:view`, `billing:view` |

### 3.4 Client-side schema (new migration — additive)

```sql
core.permissions      (key text pk, name text, category text, description text)
core.roles            (id uuid pk, name text, slug text unique, scope text check ('client','org','both'),
                       is_system bool, is_preset bool, is_active bool,
                       client_id uuid null references core.clients,   -- null = system/preset; set = custom per-client (later)
                       description text, created_at, updated_at)
core.role_permissions (role_id, permission_key, pk (role_id, permission_key))

alter core.client_members        add role_id uuid references core.roles;  -- seeded 'manager' text → Client Admin; drop old col
alter core.organization_members  add role_id uuid references core.roles;  -- table unused today, safe

core.user_invites     (id uuid pk, email text, role_id,
                       client_id uuid null, organization_id uuid null,
                       check (exactly one of client_id / organization_id),
                       token text unique, invited_by uuid,
                       expires_at, accepted_at null, created_at)
```

---

## 4. The employee RBAC model (Softphone pattern)

### 4.1 Schema (new migration — additive; same shape, separate tables)

```sql
core.employee_permissions      (key text pk, name text, category text, description text)
core.employee_roles            (id uuid pk, name text, slug text unique,
                                is_system bool, is_preset bool, is_active bool,
                                description text, created_at, updated_at)
core.employee_role_permissions (role_id, permission_key, pk (role_id, permission_key))

alter core.dashboard_users add role_id uuid references core.employee_roles;  -- text role mapped: owner→admin, teamleader→team_leader, salesperson→salesperson
alter core.dashboard_users add team_id  uuid references core.employee_teams; -- NEW: teams for :team scope

core.employee_teams            (id uuid pk, name text, created_at)
core.employee_user_permissions (user_id, permission_key, pk (user_id, permission_key))  -- grant-only extras

alter core.clients add account_specialist_id uuid references core.dashboard_users(id);   -- always assigned; enforced at client creation
```

### 4.2 Employee permission catalog (seed; `resource:action[:scope]`)

| Category | Permissions |
|---|---|
| orgs | `orgs:view:all`, `orgs:view:team`, `orgs:view:assigned`, `orgs:create`, `orgs:manage`, `orgs:delete` |
| clients | `clients:view:all`, `clients:view:team`, `clients:view:assigned`, `clients:manage` |
| team | `team:view`, `team:manage` (employees + roles) |
| pricing | `pricing:manage` (tiers, message limits, payments, renewals) |
| demos | `demos:manage` |
| sales | `sales:view:all`, `sales:view:team`, `sales:view:own` |
| emergency | `emergency:manage` (kill switch / restore) |
| ~~conversations~~ | **deliberately absent** — message content is developer-only (DB access) |

Scope resolution: `:all` = everything; `:team` = clients/orgs where the Account Specialist is on my team; `:assigned` = clients/orgs where **I** am the specialist. Best (widest) granted scope wins — union, as always.

### 4.3 Seeded roles (mapping today's behavior day one)

| Role | Tier | Permissions |
|---|---|---|
| Admin | `is_system` | everything (immutable) |
| Team Leader | `is_preset` | `orgs:view:team`, `clients:view:team`, `orgs:create/manage`, `clients:manage`, `pricing:manage`, `demos:manage`, `sales:view:team`, `team:view` |
| Salesperson | `is_preset` | `orgs:view:assigned`, `clients:view:assigned`, `orgs:create`, `demos:manage`, `sales:view:own` |

Replaces today's awkward "salespeople only see orgs they created today (US Pacific)" rule with a real concept: *your book of clients*.

### 4.4 UI (employee dashboard)

- **Team page → "Users & Roles"** (Softphone layout): two tabs — **Roles** (table with preset/custom badges; edit modal with category-grouped permission switch grid; slug locked for presets; system role read-only) and **Employees** (role dropdown per row, per-user "Extra Permissions" modal — grant-only, role-derived perms shown checked+disabled, teams assignment).
- **Clients table** gains a "Specialist" column; **client detail** shows the specialist card; client create/edit has a mandatory specialist picker.
- Frontend gates every nav item / button via `hasPermission(key)`; `dashboard-api` re-checks per action server-side.

---

## 5. The KB redesign

### 5.1 Schema (new migration)

```sql
kb.kb_versions (
  id uuid pk default gen_random_uuid(),
  organization_id uuid not null references core.organizations on delete cascade,
  version int not null,
  sections jsonb not null,           -- [{title, body}, ...]
  change_summary text,
  source text not null default 'dashboard',  -- 'dashboard' | 'customer_amend' | 'template' | 'migration'
  created_by uuid, created_by_name text,
  created_at timestamptz default now(),
  unique (organization_id, version)
);
alter core.organizations add column active_kb_version_id uuid references kb.kb_versions;
```

**Rules:**
1. Nothing is ever edited in place. Amend = insert new version + move `active_kb_version_id`.
2. Rollback = new version copying the target's sections (`change_summary = "rollback to v3"`). The pointer never moves backwards.
3. The AI always reads through the pointer.
4. `kb_amend_requests` keeps its job (customer proposes → employee reviews), gains `applied_version_id`; its `document_id` column becomes obsolete.

### 5.2 Data migration (nothing gets lost)

Per org, in one transaction:
1. Order `kb_chunks` by document, then `chunk_index`.
2. Map each chunk → `{title: heading, body: content}` section (chunks are already `(heading, content)` pairs — structure survives, hashtags die).
3. Insert as **v1**, `source='migration'`, `change_summary='migrated from chunked KB'`.
4. Set `organizations.active_kb_version_id`.
5. **Do NOT drop `kb_documents`/`kb_chunks` yet** — retired backup until the new pipeline is verified live; dropped in a later migration (end of Phase 2).

### 5.3 Backend touchpoints

| Place | Change |
|---|---|
| `widget-chat` + `handle-inbound-email` | Prompt builder: read active version's `sections`, serialize to plain text (`Title\nBody\n\n…`). Prompt content unchanged; one less join |
| `kb-ingest` | Rewritten thin: validate + create new version (no chunking, no `chunk_code`) |
| `dashboard-api` | `kb_ingest` → creates version; `get_kb_chunks` → `get_kb_version`; new `list_kb_versions`; amend-apply creates version from `kb_amend_requests` |
| `customer-api` | KB reads via active version; `submit_kb_amend` unchanged (still a request, not a direct edit) |
| Demo templates | KB copy = insert v1 on the target org |
| Voice plan | `_shared/horus-prompt.ts` extraction gets simpler: one sections→text serializer shared by chat/email/voice/SMS. Update `docs/voice-channel-plan.md` KB references when we get there |

### 5.4 UI (employee dashboard KB tab, rewritten)

- Sections rendered formatted: collapsible, titled, styled — **no markdown syntax visible ever**
- Per-section edit with a minimal rich-text control (bold / lists / links only)
- Add / remove / reorder sections; "Save as new version" with change-summary field
- Version history: version, date, author, summary, which sections changed (compare by title/body — no diff tooling)
- Rollback button per version (creates the copy-version)
- Later (customer dashboard repo): read-only formatted KB + amend request form

---

## 6. Invite flow (customer users don't exist yet — they must be invited)

1. Employee (client detail view) or later client admin (customer dashboard) enters email + role + tier (client-level or org-level).
2. `user_invites` row created (email, role_id, client_id XOR organization_id, token, expiry 7 days).
3. Invite email sent (decision at build time: Supabase Auth `inviteUserByEmail` magic-link vs. own system mailbox — default: Supabase Auth, least moving parts).
4. Accept link → accept page → creates Supabase auth user + `core.customer_users` row (if new) + membership row with the invited role → `accepted_at` stamped.
5. Existing-user invites skip account creation; membership is just added.

---

## 7. Phases — exactly what changes, in order

Each phase is independently deployable and verified before the next starts.
**RBAC (both systems) is built LAST** — everything before Phase 5 keeps today's simple owner/salesperson checks; Phase 5 swaps in the permission middleware in one sweep.

### Phase 1 — KB backend: de-chunk + immutable versions ✅ DONE 2026-09-11
- Migration `20260911000000_kb_versions.sql` applied live: `kb.kb_versions` + `organizations.active_kb_version_id`; all 13 orgs (2 real + 11 demos) migrated to v1 with sections, pointers verified; bodies trimmed.
- `kb-ingest` rewritten: thin version-creator (markdown/FAQ → sections; append or replace; legacy `chunks_created` alias kept for the current toast).
- `widget-chat` + `handle-inbound-email`: prompt builders read the active version's sections (legacy chunk fallback for unmigrated orgs); KB_MAX_CHARS safety valve kept.
- `dashboard-api`: `get_org` kbDocs shim (active version as one pseudo-doc), `get_kb_chunks` serves sections chunk-shaped, `list_kb_versions` + `get_kb_version` added (for Phase 2), `delete_kb_doc` guards immutable versions, `save_demo_defaults` snapshots `{sections}`, `reset_demo` + `use_demo_template` version-aware (legacy defaults arrays still supported), delete sweeps include `kb_versions`.
- `customer-api`: `list_kb_docs` / `get_kb_chunks` shims over the active version.
- `dashboard.js`: minimal patch — version badge on the KB row, delete hidden for version rows.
- Old tables `kb_documents`/`kb_chunks` kept intact as backup; drop at end of Phase 2.
- **Verified live 2026-09-11:** all 5 functions deployed; test widget conversation answered correctly from the migrated KB (Horus Desk org).

### Phase 2 — KB UI (employee dashboard) ✅ IMPLEMENTED 2026-09-11 (drop pending owner verification)
- KB tab rewritten as a **sections editor**: collapsible formatted sections (no markdown shown), per-section edit with bold/list/link toolbar, add/delete/reorder sections, "Save as New Version" with required change summary, discard-changes.
- **Version history** card: every version with summary/author/date, read-only View modal, Rollback (creates a new copy-version — pointer never moves backwards).
- **Amend requests** review card: Apply appends the request as a new section in a new version (`source='customer_amend'`, links `applied_version_id`); Dismiss with optional notes.
- `dashboard-api` (+deployed): `save_kb_sections`, `rollback_kb_version`, `list_kb_amend_requests`, `review_kb_amend` (alongside Phase 1's `list_kb_versions`/`get_kb_version`).
- Migration `20260912000000_kb_amend_applied_version.sql` applied live.
- Old chunk-based modals (`showAddKbModal`/`showEditKbModal`/`submitKbDoc`/`deleteKbDoc`) removed.
- Legacy cleanup applied: `20260913000000_kb_drop_legacy_chunk_tables.sql` dropped `kb_documents`, `kb_chunks`, and `kb_amend_requests.document_id`; remaining dead references removed from `dashboard-api` (TABLE_SCHEMA, delete sweeps, reset_demo) and the legacy chunk fallback removed from both AI pipelines. **Verified live after drop:** widget chat answers from the versioned KB; `kb` schema now holds only `kb_versions` + `kb_amend_requests`.

### Phase 3 — Org detail redesign
- Business profile / services / hours / staff editing UI (currently no UI anywhere — the AI reads them blind).
- Tab consolidation (Notifications duplication, Widget's 3 save buttons, Settings declutter) per the audit — sub-plan when we get here, RBAC domains as the grouping guide.
- **Verify:** employees manage everything except conversation content (§2 principle).

### Phase 4 — Client detail view (employee dashboard)
- New `client-detail` view (click client row): client info edit, **Account Specialist** card + picker, orgs table (click-through to org detail), link/unlink org.
- Small additive migration: `clients.account_specialist_id → core.dashboard_users`.
- Clients table gains "Specialist" column.
- `dashboard-api` actions (owner-only for now): `get_client`, `update_client`, `assign_specialist`, `link_org`, `unlink_org`.
- **Members/invites UI is NOT in this phase** — assigning a user means picking a role, and roles don't exist until Phase 5.
- **Verify:** specialist assigned + displayed; link/unlink moves orgs between clients and unassigned.

### Phase 5 — RBAC: both systems (schema + employee UI + members UI)
- New migration per §3.4 + §4.1: client RBAC tables, employee RBAC tables, `employee_teams`, `dashboard_users.role_id`/`team_id` mapping, seed both catalogs + preset roles.
- Team page rewritten as **Users & Roles** (Roles tab + Employees tab, §4.4) — Softphone layout.
- `dashboard-api`: permission middleware (`hasPermission`), all existing actions mapped to permission keys, roles/permissions CRUD (`get_roles`, `save_role`, `delete_role`, `get_permissions`, `get_user_permissions`, `set_user_permissions`).
- Client detail view gains members management: `list_client_members`, `invite_user`, `remove_member`, `update_member_role`; org detail gains org-level members.
- **Verify:** catalogs + roles seeded; each employee sees exactly their scope (`:all`/`:team`/`:assigned`); preset role amend persists; extras grant works; system role immutable; memberships get `role_id`.

### Phase 6 — Invite acceptance
- `accept-invite` edge function + minimal accept page.
- Creates auth user + `customer_users` + membership; stamps `accepted_at`; expiry enforced.
- **Verify:** full round trip — invite → email → accept → membership with correct role.

### Phase 7 — `customer-api` authz rewrite
- Replace email-match access with §3.1 resolution (owner ∪ client_members ∪ organization_members).
- Permission middleware: every action declares required permission.
- `notification_recipients` returns to being **only** alert routing.
- **Verify:** existing customer users retain equivalent access (map current access → seeded memberships); denials return clean 403s.

### Later (tracked, not planned here)
- **Customer dashboard** (separate repo): client self-serve user management, formatted KB reading + amend requests, inbox.
- **SMS + voice channels** per `docs/voice-channel-plan.md` — slots into `inbox:*` / `channels:manage` permissions and the shared prompt builder with zero RBAC changes.

---

## 8. Out of scope (explicitly)

- No conversation/message viewing features for employees — ever (§2 principle).
- No custom per-client role UI (schema supports it; UI later).
- No RLS hardening pass (Softphone pairs RBAC with planned RLS hardening; ours is a separate future decision).
- No SMS/voice implementation (plan exists; starts after the employee dashboard redesign).
- No customer dashboard frontend (different repo, after this).

## 9. Hard rules while building

- One phase at a time; owner approves before each phase starts.
- Migrations additive-first; drops only after live verification.
- No employee-facing message bodies in `dashboard-api` responses.
- Union semantics only: no deny rules, no subtractive overrides, either RBAC system.
- Update this doc + `docs/voice-channel-plan.md` whenever a locked decision changes.
