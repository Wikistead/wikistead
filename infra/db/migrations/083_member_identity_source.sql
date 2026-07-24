-- Migration 083: members.identity_source (#523 / ADR-190).
--
-- Where a member's identity came from. 'oidc' (the OIDC/SSO subject — today's ONLY provisioning path,
-- so the default keeps every existing member unchanged) vs 'local' (a locally-created user, a future
-- feature). ADR-190 §2: an OIDC member's display name is the IdP name (authoritative, anti-impersonation)
-- so the account-settings display_name_override write is refused for them; a 'local' user may still set
-- one. `admin_origin` (081) is a DISTINCT concept (how an admin tuple was produced) and is NOT reused.
ALTER TABLE members ADD COLUMN IF NOT EXISTS identity_source TEXT NOT NULL DEFAULT 'oidc';
