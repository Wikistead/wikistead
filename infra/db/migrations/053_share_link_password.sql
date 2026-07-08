-- Migration 053: share-link password protection (#233 / ADR-107, Accepted).
--
-- An OPTIONAL password on a share link. A leaked URL alone no longer grants access: the token-exchange
-- (`mint`) step, AFTER the authoritative FGA check, additionally requires the password when this is set.
-- Stored as a scrypt hash + per-link salt (never plaintext) — see share-link-password.ts. Nullable: an
-- existing / password-less link behaves byte-identically (the mint branch is skipped when NULL).
-- Set AT ISSUANCE only in v1 (no link-update endpoint); changing protection = revoke + re-issue.
ALTER TABLE share_links ADD COLUMN password_hash TEXT;
