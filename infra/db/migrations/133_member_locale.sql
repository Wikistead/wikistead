-- Migration 133: members.locale (#1005, ADR-260 §3.1).
--
-- Per-member mail language, nullable: unset means "resolve from the tenant default, then 'en'"
-- (resolveMailLocale, apps/server/src/i18n/locale.ts) — never an error, and never guessed from a
-- header, per the ADR. Written by the account settings screen that already resolves a locale in the
-- browser (§3.2); nothing in this migration backfills a value, since there is nothing to infer one from.
ALTER TABLE members ADD COLUMN IF NOT EXISTS locale TEXT;
