-- Migration 052: default personal space (#226 / ADR-106, Accepted).
--
-- On first sign-in a member gets ONE owner-only "personal" space (created via the normal createSpace path,
-- so it carries only tenant + owner-manager FGA tuples — no user:* / no other-member tuple, i.e. it is a
-- normal space that happens to have a single owner). `personal_owner_sub` marks such a space so the
-- auto-create is IDEMPOTENT: a partial UNIQUE index makes concurrent first-logins race-safe (the DB is the
-- final authority — the read pre-check is only a fast path), and one member = one personal space.
--
-- "本人のみ可視" means invisible to ORDINARY members, NOT to a tenant admin: `manager: ... or admin from
-- tenant` still applies (ADR-106 decision 1(a)). Personal spaces are EXEMPT from maxSpaces (decision 2) —
-- that exemption lives in createSpace's personal path, not here.
ALTER TABLE spaces ADD COLUMN personal_owner_sub TEXT;

-- One personal space per (tenant, owner). Partial: only personal spaces are constrained; ordinary spaces
-- (NULL personal_owner_sub) are unaffected. This UNIQUE is the race authority for concurrent first-logins.
CREATE UNIQUE INDEX spaces_personal_owner_uniq
  ON spaces (tenant_id, personal_owner_sub)
  WHERE personal_owner_sub IS NOT NULL;
