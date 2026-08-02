-- Migration 105: local_credentials (#568 / ADR-198 §1) — password sign-in for members whose identity
-- this product issues, rather than an external IdP.
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT in this file.
--
-- The hash lives in its OWN table, not on `members`: members is read on hot paths and a password hash
-- must never ride a `SELECT *`. This table is read at login and at change, and written only by the
-- four writers ADR-198 §2 names (invite acceptance, reset, change, the break-glass first-admin mint).
--
-- `member_sub` is always a `wlocal_`-prefixed subject: this product minted it, so it carries the
-- reserved prefix that #569/#592 reserved for exactly this (an external IdP may never assert one). The
-- CHECK makes that a property of the data rather than of the code that writes it.
--
-- The composite FK to members means a credential cannot outlive its member, and ON DELETE CASCADE is
-- backed by an EXPLICIT delete in the member-removal transaction (ADR-198 §1 M4): without it, the
-- UNIQUE (tenant_id, identifier) would permanently block re-inviting the same address, and a dormant
-- hash would outlive the person it authenticated.
CREATE TABLE local_credentials (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  member_sub    TEXT NOT NULL CHECK (member_sub LIKE 'wlocal\_%'),
  identifier    TEXT NOT NULL,                 -- the login name: the invite's email, lowercased
  password_hash TEXT NOT NULL,                 -- scrypt, parameters encoded in the string (ADR-198 §4)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, member_sub),
  UNIQUE (tenant_id, identifier),
  FOREIGN KEY (tenant_id, member_sub) REFERENCES members(tenant_id, sub) ON DELETE CASCADE
);

ALTER TABLE local_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON local_credentials
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE local_credentials TO app;
