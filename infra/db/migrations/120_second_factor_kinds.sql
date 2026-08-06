-- Migration 120: WHICH kinds of second factor the tenant accepts (#676 / ADR-222 §1).
--
-- 118 gave the tenant one bit — is a second factor required — and ADR-222 records why that is not
-- enough: a passkey resists phishing and dies when the host changes, a TOTP code does neither, and
-- "require a second factor" means something different to a tenant that wants the first property than to
-- one with a domain move scheduled.
--
-- ONE COLUMN, not a boolean plus a set. Two columns can express `required = false, kinds = passkey` —
-- a state with no meaning that every reader would have to defend against. The stance is a single value:
--
--   off       nothing is required                                  (118's FALSE)
--   any       any factor that can be presented here satisfies it    (118's TRUE)
--   passkey   only a passkey
--   totp      only an authenticator app
--
-- `any` rather than a set of two, because the day a third kind ships `any` means "including the new
-- one" and an explicit {passkey,totp} means "not the new one" — and only one of those is what a tenant
-- clicking "both" in 2026 meant to say.
--
-- `off` IS NOT THE EMPTY SET, and the application must not read it as one (ADR-222 §1): under `off`
-- both enrolment doors stay open, the floor is not consulted and the sweep does not run. An
-- implementation that refused enrolment of every unaccepted kind AND read `off` as accepting none would
-- close every door to enrolment — and then the floor can never be met, so the stance could never be
-- turned on again.
--
-- BACKFILLED FROM 118, so no tenant's behaviour changes on deploy: the axis exists and nobody is on it.
-- 118's column stays for now rather than being dropped in the same migration — a rollback that has to
-- reconstruct a boolean from a text value is a rollback nobody wants to write at the time they need it.
-- Retiring it belongs to a later slice, once nothing reads it.
ALTER TABLE tenant_login_prefs
  ADD COLUMN IF NOT EXISTS second_factor_kinds TEXT NOT NULL DEFAULT 'off';

-- A CHECK rather than an enum type: adding a kind should be a migration line, not an ALTER TYPE that
-- takes a lock on every row (the same choice migration 117 made for `member_factors.kind`, and for the
-- same reason).
ALTER TABLE tenant_login_prefs
  DROP CONSTRAINT IF EXISTS tenant_login_prefs_second_factor_kinds_check;
ALTER TABLE tenant_login_prefs
  ADD CONSTRAINT tenant_login_prefs_second_factor_kinds_check
  CHECK (second_factor_kinds IN ('off', 'any', 'passkey', 'totp'));

UPDATE tenant_login_prefs
  SET second_factor_kinds = CASE WHEN second_factor_required THEN 'any' ELSE 'off' END
  WHERE second_factor_kinds = 'off' AND second_factor_required;
