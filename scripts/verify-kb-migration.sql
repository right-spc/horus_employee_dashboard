-- Verification for 20260911000000_kb_versions.sql — read-only.
SELECT
  o.name AS org,
  o.is_demo,
  v.version,
  jsonb_array_length(v.sections) AS section_count,
  (o.active_kb_version_id = v.id) AS pointer_set,
  left(v.sections->0->>'title', 40) AS first_section_title,
  left(v.sections->0->>'body', 80) AS first_section_body_preview
FROM core.organizations o
JOIN kb.kb_versions v ON v.organization_id = o.id
ORDER BY o.is_demo, o.name;
