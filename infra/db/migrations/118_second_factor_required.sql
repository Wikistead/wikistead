-- Migration 118: the tenant's second-factor STANCE (#652 / ADR-219 §4).
--
-- Joins the other stances on `tenant_login_prefs` (087 platform, 106 local, 110 sso_required) rather
-- than growing a table of its own: they are the same kind of fact — what this tenant requires of the
-- people signing in — and a reader asking "what does this tenant demand" should find them together.
--
-- DEFAULT FALSE for the same reason 110 is: a stance is a DECISION. A migration that turned it on would
-- lock out every member of every existing tenant on deploy, which is the exact failure ADR-219 §4 spends
-- its length preventing.
--
-- The column carries no guard of its own. Both halves of the floor live in the routes, because both are
-- questions about OTHER rows (does an admin hold a confirmed factor; is this the last one) that a CHECK
-- cannot ask:
--   - turning it ON needs at least one admin with a confirmed factor   (admin-login-methods.ts)
--   - while it is on, that last admin may not remove their factor      (second-factor.ts)
-- #605's guard is two-sided for the same reason, and ADR-219 §4 copies it deliberately: a precondition
-- with no matching refusal on the way out dies one delete after it is satisfied.
ALTER TABLE tenant_login_prefs
  ADD COLUMN IF NOT EXISTS second_factor_required BOOLEAN NOT NULL DEFAULT FALSE;
