-- Migration 010: share_links — anonymous guest access links.
--
-- One share_link = one resource (the project design notes). The FGA tuple
-- (page:X#{view|edit}@share_link:<id>) is the AUTHORITY; this table holds
-- metadata for listing/management and lets the public landing endpoint mint a
-- short-lived guest token on demand. Revocation deletes the FGA tuple (1 op);
-- this table's revoked_at is only a fast first-pass hint, never the security
-- gate (the FGA check is — see routes/share-links.ts).
--
-- id is a v4 UUID (gen_random_uuid). It is the unguessable capability embedded in
-- the share URL: the public token endpoint is unauthenticated, so the only thing
-- protecting a link is that its id cannot be guessed/enumerated. NEVER make this
-- sequential.
CREATE TABLE share_links (
  id            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  resource_type TEXT NOT NULL,                 -- 'page' (space-scoped links are future)
  resource_id   TEXT NOT NULL,
  capability    TEXT NOT NULL,                 -- 'view' | 'edit'
  expires_at    TIMESTAMPTZ,                   -- NULL = permanent link
  created_by    TEXT NOT NULL,                 -- 'user:<id>' that issued the link
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,                   -- NULL = active
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);

ALTER TABLE share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON share_links
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE share_links TO app;

CREATE INDEX share_links_resource_idx ON share_links (tenant_id, resource_type, resource_id);
