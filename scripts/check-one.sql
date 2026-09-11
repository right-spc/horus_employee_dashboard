SELECT sections->0 AS s0, sections->1 AS s1
FROM kb.kb_versions
WHERE organization_id = (SELECT id FROM core.organizations WHERE name = 'HVAC');
