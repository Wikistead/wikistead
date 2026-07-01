-- Migration 047: operator audit ledger (#179 / ADR-089).
--
-- A durable, append-only, hash-chained record of OPERATOR out-of-band privileged actions (today:
-- break-glass tenant-OIDC recovery). SEPARATE from the tenant `audit_log` (#177): operator actions are
-- above/across tenants, must NOT be visible to any tenant, and a CLI break-glass has no tenant session.
--
-- Isolation = operator/admin role ONLY. The tenant `app` role gets NO grants, and RLS is enabled +
-- FORCED with NO policy = default-deny, so even an accidental future GRANT can't expose it. The admin
-- role (DATABASE_ADMIN_URL, BYPASSRLS) is what writes/reads it. A single GLOBAL chain (one operator
-- scope, not per-tenant): `seq` is monotonic; each row carries the previous row's hash so any tamper /
-- deletion / reorder breaks the chain (verifyAuditChain). Only integrity fields are stored — actor /
-- action / target / time — NEVER secrets/tokens/config (ADR-070: the ledger must not itself be a
-- disclosure surface), which is exactly why break-glass can be logged safely.
CREATE TABLE operator_audit_log (
  seq       BIGINT PRIMARY KEY,    -- monotonic; single global operator chain (ordering + dedup)
  actor     TEXT NOT NULL,         -- 'operator:<id>'
  action    TEXT NOT NULL,         -- e.g. 'tenant.oidc_recovered'
  target    TEXT NOT NULL,         -- affected resource, e.g. 'tenant:<id>' ('' when not applicable)
  at        TEXT NOT NULL,         -- ISO 8601 string, stored BYTE-EXACT (it is a hash input; a
                                   -- TIMESTAMPTZ round-trip could drift precision and break verify)
  prev_hash TEXT NOT NULL,         -- previous entry's hash ('' for the genesis entry)
  hash      TEXT NOT NULL          -- sha256(prev_hash || canonical(core)) — the chain link
);

-- Operator-only. RLS forced + no policy ⇒ default-deny for any non-BYPASSRLS role; and the tenant
-- `app` role holds no privileges here regardless. The admin/operator role (BYPASSRLS) accesses it.
ALTER TABLE operator_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_audit_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE operator_audit_log FROM app;
