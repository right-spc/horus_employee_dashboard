-- Org logo: uploaded via the dashboard, stored in a public Storage bucket,
-- URL kept on the org row. The widget shows it in the header + AI avatar.
alter table core.organizations
  add column if not exists logo_url text;

-- Public read bucket (widget loads it on client sites). Writes go through
-- dashboard-api with the service role, which bypasses storage RLS — no
-- policies needed, anon/authenticated writes stay denied by default.
insert into storage.buckets (id, name, public)
values ('org-assets', 'org-assets', true)
on conflict (id) do nothing;
