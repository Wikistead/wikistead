-- Migration 074: the operator-console read role + console access log (#434 / ADR-170).
--
-- The Cloud operator console (a SEPARATE deployment — never a tenant-app route) must read the
-- break-glass ledger WITHOUT the admin DSN: handing an HTTP workload BYPASSRLS would let it read
-- every tenant table. Instead a dedicated `operator_ro` role (NOBYPASSRLS, no LOGIN — ops create
-- the LOGIN member out-of-band) gets exactly two capabilities:
--   1. SELECT on operator_audit_log via a ROLE-SCOPED policy. This AMENDS 047's "no policy"
--      wording honestly: the invariant is now "no policy visible to the app role" — `app` matches
--      no policy and still reads ZERO rows (default-deny re-pinned in tests), and the ledger stays
--      UPDATE/DELETE-impossible for the console (no such grant, no such policy).
--   2. INSERT into a SEPARATE append-only operator_console_access_log — every console read is
--      recorded (watchers get watched) OUTSIDE the hash chain, so routine views never bury actual
--      break-glass entries and the console needs zero write access to the ledger itself.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'operator_ro') THEN
    CREATE ROLE operator_ro NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT SELECT ON operator_audit_log TO operator_ro;
CREATE POLICY operator_console_read ON operator_audit_log
  FOR SELECT TO operator_ro USING (true);

-- The console access log: append-only for operator_ro (no SELECT/UPDATE/DELETE — reading it back
-- is an admin/ops task). RLS forced with an INSERT-only policy so even a future stray GRANT can't
-- widen the console's reach; the admin role (BYPASSRLS) reads it for review.
CREATE TABLE operator_console_access_log (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sub     TEXT NOT NULL,          -- the verified operator subject (JWT sub)
  path    TEXT NOT NULL,          -- '/ledger' | '/ledger/verify'
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE operator_console_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_console_access_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE operator_console_access_log FROM app;
GRANT INSERT ON TABLE operator_console_access_log TO operator_ro;
GRANT USAGE ON SEQUENCE operator_console_access_log_id_seq TO operator_ro;
CREATE POLICY operator_console_access_append ON operator_console_access_log
  FOR INSERT TO operator_ro WITH CHECK (true);
