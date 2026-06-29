-- Migration 032: catch-up GRANT for orphan_claims (#99 / ADR-061).
--
-- 031 originally created orphan_claims without the app-role GRANT; the GRANT was added to
-- 031 afterwards. DBs that applied 031 before that edit need the GRANT applied separately.
-- GRANT is idempotent, so this is a harmless no-op on a fresh DB that already ran the
-- corrected 031. Keeps the runtime 'app' role able to read/write claims under RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE orphan_claims TO app;
