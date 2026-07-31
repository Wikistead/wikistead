-- Migration 090: per-member email delivery preferences (#547 / ADR-196 §3, ADR-020 self-scope).
--
-- immediate defaults ON (the mention mail matches the invite's existing direct-mail expectation, and
-- the new pipeline is a NARROWING of today's behavior — it finally honors the #362 kill switch, the
-- default event mask and the published-only rule); digest defaults OFF (a recurring rollup is new
-- volume — opt-in). Both sit UNDER the #362 kill switch (notifications_enabled=false silences email
-- too, enforced at fan-out).
ALTER TABLE members ADD COLUMN IF NOT EXISTS email_immediate BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE members ADD COLUMN IF NOT EXISTS email_digest    BOOLEAN NOT NULL DEFAULT false;
