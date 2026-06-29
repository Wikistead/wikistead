-- Migration 031: orphan-draft admin claims (#99 / ADR-061).
--
-- Records a tenant#admin's TEMPORARY claim on an orphaned strict-private draft so a
-- reconciling sweep can expire it. The FGA model has no user-scoped `non_expired`
-- condition (that would be a DSL change → separate ADR), so the TTL is enforced HERE,
-- not in a time-conditioned tuple. A row exists only between claim and reassign/expiry;
-- the actual temporary access is the admin's FGA `manage` grant, written on claim and
-- revoked when this row is removed (by reassign, or by the sweep past expires_at).
-- One active claim per page (PK) = the one-at-a-time recovery the ADR specifies.
CREATE TABLE orphan_claims (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  page_id     TEXT NOT NULL,
  admin_sub   TEXT NOT NULL,                 -- the tenant#admin holding the temp grant
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,          -- the sweep revokes the grant past this
  PRIMARY KEY (tenant_id, page_id),
  FOREIGN KEY (tenant_id, page_id) REFERENCES pages(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE orphan_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE orphan_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orphan_claims
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE orphan_claims TO app;
