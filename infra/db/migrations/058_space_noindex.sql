-- Migration 058: space-level noindex flag (#277 / ADR-116 guardrail 4).
--
-- Set true when a space is made public (in the same tx as the anonymous
-- space:S#viewer@user:* wildcard write), so a newly-public space is never
-- crawler-indexed by default. Served as X-Robots-Tag on the public space-tree
-- route AND OR'd with each page's own pages.noindex on the public page route
-- (a page reached via space inheritance is noindex if EITHER flag is set).
-- The spaces table already carries RLS from its own migration; a column add
-- inherits it (no new policy needed).

ALTER TABLE spaces ADD COLUMN noindex BOOLEAN NOT NULL DEFAULT false;
