-- Migration 075: Access Transparency — the per-tenant PROJECTION of operator break-glass
-- (#435 / ADR-169, EE). The sealed global operator_audit_log (047) stays untouched and
-- tenant-inaccessible; this table is a tenant-scoped disclosure written IN THE SAME admin
-- transaction as every operator append (appendOperatorEntry — reliability by construction).
-- It carries its OWN per-tenant hash chain (the 043 construction) so a tenant admin can verify
-- exactly their rows; `at` is TEXT (byte-exact hash input — the 047 lesson, unlike 043's
-- TIMESTAMPTZ whose round-trip re-rendering cost a re-hash shim). `actor` is the operator's
-- STABLE PSEUDONYM (owner ruling: track the same person across incidents, never the identity).
-- `reason` is a FIXED enum code, never free text (a support note could leak another customer's
-- data — ADR-070). READ-ONLY to the tenant: the app role gets SELECT only; INSERT stays on the
-- admin/operator connection (BYPASSRLS) that writes the ledger.
CREATE TABLE IF NOT EXISTS tenant_transparency_log (
  -- NO tenants FK: the sealed ledger outlives tenant rows (a deleted tenant's disclosure history
  -- must not cascade away), and operator targets are not guaranteed to still exist at append time.
  tenant_id  TEXT NOT NULL,
  seq        BIGINT NOT NULL,           -- per-tenant monotonic (its own chain, not the global seq)
  actor      TEXT NOT NULL,             -- stable operator pseudonym ('operator-<12hex>')
  action     TEXT NOT NULL,             -- the operator action code, e.g. 'tenant.oidc_recovered'
  reason     TEXT NOT NULL,             -- fixed enum code ('support_ticket'|'incident'|...|'unspecified')
  target     TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL,             -- byte-exact ISO (hash input)
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seq)
);
ALTER TABLE tenant_transparency_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_transparency_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_transparency_log
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT ON TABLE tenant_transparency_log TO app;
