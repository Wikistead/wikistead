-- Migration 117: second factors (#656 / ADR-219 §7).
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT in this file.
--
-- WHY NOT `local_credentials`: its primary key is (tenant_id, member_sub) — one row per person. The
-- requirement is the opposite shape: one person holds SEVERAL factors (a phone, a YubiKey, a laptop),
-- lists them, names them and removes them one at a time. A table that can hold one cannot be widened
-- into a table that holds many without changing its key, so this is a new table rather than columns.
--
-- WHY TWO TABLES: ADR-219 §7 records that storage differs per factor and cannot be one sentence — a
-- TOTP secret is ENCRYPTED (verification needs it back), while a passkey stores a public key, a
-- credential id and a signature counter and has no secret at all. Everything the product does with a
-- factor generically — list it, name it, say when it was last used, delete it — is the same for both,
-- so that lives in the header here and each kind brings its own detail table. The alternative shapes
-- were both worse: one wide table would need columns invented for WebAuthn before its design is settled
-- (ADR-219 §1 puts passkeys after TOTP), and one table per kind with no header makes the list a UNION
-- that grows a branch every time a kind is added.
--
-- Deliberately NOT here: no `wlocal_` CHECK on member_sub. `local_credentials` has one because a
-- password IS a product-issued identity; a factor is not. ADR-219 does not restrict who may enrol, and
-- a CHECK would encode a decision nobody made — whether a federated member may hold a factor that §3
-- says their door is never asked for is a question for the enrolment surface (#653/#657), not for the
-- shape of the data.
CREATE TABLE IF NOT EXISTS member_factors (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  member_sub   TEXT NOT NULL,
  -- 'totp' today; 'passkey' when ADR-219 §1's second half lands. A CHECK rather than an enum type, so
  -- adding a kind is a migration line and not an ALTER TYPE that locks the table.
  kind         TEXT NOT NULL CHECK (kind IN ('totp', 'passkey')),
  -- what the member calls it ("work phone"). Theirs to write, so it is not unique and not validated.
  label        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL until the enrolment is confirmed by presenting a code (#657). An unconfirmed row is NOT a
  -- factor: counting it would let somebody satisfy a policy by starting an enrolment and walking away,
  -- and would let the last admin "hold a factor" they have never proved they can use.
  confirmed_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  -- The composite FK is what makes a factor unable to outlive its member. ON DELETE CASCADE is the
  -- floor; ADR-219 §7 also requires an explicit delete in the member-removal transaction (#654),
  -- because a row left behind attaches to whoever next holds that `sub`.
  FOREIGN KEY (tenant_id, member_sub) REFERENCES members(tenant_id, sub) ON DELETE CASCADE
);

-- The lookup every path makes: "what CONFIRMED factors does this member have". Partial, because an
-- unconfirmed row is never an answer to that question and indexing it would put abandoned enrolments in
-- the way of the only query that matters.
CREATE INDEX IF NOT EXISTS idx_member_factors_confirmed
  ON member_factors (tenant_id, member_sub)
  WHERE confirmed_at IS NOT NULL;

ALTER TABLE member_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_factors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON member_factors;
CREATE POLICY tenant_isolation ON member_factors
  USING (tenant_id = current_setting('app.tenant_id', TRUE))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE member_factors TO app;

-- The TOTP detail. ADR-219 §7: the secret is ENCRYPTED and NOT hashed — verification recomputes the
-- code from it, so it has to come back. `secret-crypto.ts` (AES-256-GCM, the same at-rest shape the
-- tenant OIDC client secrets use) is what writes this column; the name says `_enc` so a plaintext write
-- looks wrong at the call site rather than only in the database.
CREATE TABLE IF NOT EXISTS member_totp_secrets (
  factor_id  TEXT PRIMARY KEY REFERENCES member_factors(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  secret_enc TEXT NOT NULL,
  -- The last step this member spent, for refusing a replay (#657). A code is valid for its whole ±1
  -- window by construction, so "already used" is a fact about a counter and cannot live in the
  -- verifier. NULL = nothing spent yet.
  last_counter BIGINT
);

ALTER TABLE member_totp_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_totp_secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON member_totp_secrets;
CREATE POLICY tenant_isolation ON member_totp_secrets
  USING (tenant_id = current_setting('app.tenant_id', TRUE))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE member_totp_secrets TO app;
