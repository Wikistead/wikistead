-- Migration 119: passkeys, the detail table beside the TOTP one (#663 / ADR-219 §1 §7).
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT in this file.
--
-- 117 split `member_factors` into a header and a per-kind detail precisely so this migration could be
-- written without touching the header: `kind` already accepts 'passkey', the list, the label, the
-- timestamps and the deletion cascade are all shared. What a passkey needs that a TOTP secret does not
-- is here, and NOTHING here is a secret — a public key is public, which is the whole point of the
-- format and the reason ADR-219 §7 refused to describe storage in one sentence.
CREATE TABLE IF NOT EXISTS member_passkeys (
  factor_id   TEXT PRIMARY KEY REFERENCES member_factors(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  -- The authenticator's own id for this credential, base64url. UNIQUE per tenant: the same key
  -- registered twice would otherwise be two rows that both answer to one assertion, and the second
  -- would carry a stale sign counter.
  credential_id TEXT NOT NULL,
  public_key    TEXT NOT NULL,           -- base64url COSE key; verification needs it, nobody needs it secret
  -- The authenticator's monotonic counter. It may be 0 forever (many platform authenticators never
  -- increment), but if it ever GOES BACKWARDS that is the signal the spec exists to give: two devices
  -- answering for one credential, i.e. a clone. Enforced in code (#665), stored here.
  sign_count    BIGINT NOT NULL DEFAULT 0,
  -- 'usb', 'nfc', 'ble', 'internal', 'hybrid' — a hint for the browser's next prompt, and the only
  -- thing that lets a list say "your phone" rather than "an authenticator".
  transports    TEXT[] NOT NULL DEFAULT '{}',
  -- The RP ID this credential was created under. Recorded rather than assumed, because ADR-219 §1 rules
  -- that a custom-domain move re-enrols everybody: without this column, "which of these still work
  -- here" is unanswerable, and #664's warning would have nothing to count.
  rp_id         TEXT NOT NULL,
  UNIQUE (tenant_id, credential_id)
);

ALTER TABLE member_passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_passkeys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON member_passkeys;
CREATE POLICY tenant_isolation ON member_passkeys
  USING (tenant_id = current_setting('app.tenant_id', TRUE))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE member_passkeys TO app;

-- The lookup an assertion makes: "whose credential is this". By credential id, which is what the
-- authenticator sends and the only thing the request carries before anybody is identified.
CREATE INDEX IF NOT EXISTS idx_member_passkeys_credential
  ON member_passkeys (tenant_id, credential_id);
