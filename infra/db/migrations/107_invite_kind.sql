-- Migration 107: an invite says which KIND of identity it creates (#568 / ADR-198 §2).
--
-- Default 'oidc', so every invite that exists (and every one an unchanged caller writes) keeps
-- meaning exactly what it meant: "sign in at the IdP and you are seated". A 'local' invite is the
-- other shape — the person sets a password during acceptance and that becomes their way in.
--
-- A local invite REQUIRES an email (ADR-198 §2 M7): the address IS the identifier they will sign in
-- with, and it is where an unlock or reset would be sent. The copy-a-link, no-email invite stays an
-- OIDC-only shape, which the CHECK makes a property of the row rather than a rule in one code path.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'oidc';
ALTER TABLE invites ADD CONSTRAINT invites_kind_check CHECK (kind IN ('oidc', 'local'));
ALTER TABLE invites ADD CONSTRAINT invites_local_needs_email CHECK (kind <> 'local' OR email IS NOT NULL);
