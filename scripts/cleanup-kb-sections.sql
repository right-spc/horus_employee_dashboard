-- Cosmetic cleanup: trim stray leading/trailing newlines from migrated section bodies/titles.
UPDATE kb.kb_versions
SET sections = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'title', btrim(el->>'title'),
      'body',  btrim(el->>'body', E' \n\t\r')
    )
  )
  FROM jsonb_array_elements(sections) el
)
WHERE source = 'migration';
