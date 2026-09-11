-- Verify legacy KB tables are gone and the versioned KB is the only KB storage.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'kb'
ORDER BY table_name;
