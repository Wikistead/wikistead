-- #338 / ADR-128: create the dedicated `openfga` database on the existing postgres instance so the dev (and
-- e2e / server-test) OpenFGA can run on the PERSISTENT postgres datastore — matching prod, so a
-- `docker compose down` / reboot no longer wipes the authorization store + model.
--
-- Runs ONCE per fresh volume via docker-entrypoint-initdb.d, as the postgres superuser (the `app` role from
-- 001 is NOCREATEDB and cannot create this). OpenFGA's `migrate`/`run` connect as the postgres superuser in dev
-- (it owns this database + the migration DDL); prod uses scoped credentials via the SOPS secret (#147). The
-- runtime `app` role / `app` database are unaffected.
CREATE DATABASE openfga;
