-- Runs once via docker-entrypoint-initdb.d as the postgres superuser.
-- Creates the restricted runtime role used by server/collab.
-- Production: create this role through your role-management process instead.

CREATE ROLE app WITH
  LOGIN
  PASSWORD 'app'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  NOINHERIT;

GRANT CONNECT ON DATABASE app TO app;
GRANT USAGE ON SCHEMA public TO app;
