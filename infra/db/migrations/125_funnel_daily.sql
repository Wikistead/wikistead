-- #715 / ADR-229: the acquisition funnel. Two integers per day, and nothing else.
--
-- This is the whole schema on purpose. A row cannot be narrowed to a person because a row holds no
-- tenant, no member, no IP, no user agent, no session, no share link and no page — only a date and
-- two counts. The guest invariant (no account, no seat, not in the roster) is what forbids
-- per-visitor attribution, so there is deliberately NO join between the two columns and no
-- correlation id: the ratio is directional, not per-cohort, and "improving" it later by adding an
-- identifier needs a new ruling rather than a migration.
--
-- NO RLS: this is product-wide operator data, not tenant data — there is no tenant whose row this
-- is. It is written only by the Cloud composition's collector (a CE build registers none and writes
-- nothing) and read only by `pnpm op:funnel`.
CREATE TABLE IF NOT EXISTS funnel_daily (
  day                DATE   PRIMARY KEY,
  link_visits        BIGINT NOT NULL DEFAULT 0,  -- a guest token was minted through a share link
  workspaces_created BIGINT NOT NULL DEFAULT 0   -- POST /signup/tenants succeeded
);

GRANT SELECT, INSERT, UPDATE ON TABLE funnel_daily TO app;
