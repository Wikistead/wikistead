-- ADR-115 / #289: per-user editor CHROME VISIBILITY + the first-run onboarding gate.
--   editor_chrome — JSONB visibility object:
--     { "vimToggleVisible": bool, "modesVisible": { "live": bool, "source": bool, "reading": bool, "wysiwyg": bool } }
--     NULL = never enrolled / defaults (ALL chrome shown, startup mode follows editor_display_mode).
--     Visibility ONLY — the startup mode stays in editor_display_mode (029, single source of truth).
--   onboarding_completed_at — NULL means "fire the first-run two-question flow once".
-- Self-scope: written only by the authenticated member for their OWN row + tenant RLS (ADR-020).
ALTER TABLE members ADD COLUMN editor_chrome JSONB;
ALTER TABLE members ADD COLUMN onboarding_completed_at TIMESTAMPTZ;

-- Ruling#2 (NOT inert): NULL fires the modal, so existing members MUST be backfilled as
-- completed — otherwise every existing member would be shown the first-run flow. New members
-- (rows created after this migration) start NULL → the flow fires once for them.
UPDATE members SET onboarding_completed_at = now();
