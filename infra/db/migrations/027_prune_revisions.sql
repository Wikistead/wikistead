-- Migration 027: prune revisions to keep the last N per page (#116 / ADR-008:82).
--
-- Migration 007 left "TODO(phase: revisions): add pruning (keep last N revisions per page)".
-- A single AFTER INSERT trigger is the app-agnostic chokepoint: it covers EVERY revision
-- source (collab auto-snapshot in apps/collab, publish in pages.ts, restore in revisions.ts)
-- with zero application code, so no insert path can forget to prune.
--
-- This COUNT cap is distinct from time-based retention (the entitlement historyRetentionDays,
-- enforced at list/read time): it bounds how many revisions a single heavily-revised page can
-- accumulate within the retention window, so storage cannot grow unbounded. The cap is a fixed
-- pre-launch constant (tunable later, like the other interim limits).
--
-- SECURITY INVOKER (default): the DELETE runs as the inserting app role under RLS, so it only
-- ever touches the current tenant's rows — and only the just-inserted page's revisions.

CREATE OR REPLACE FUNCTION prune_revisions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM revisions
   WHERE page_id = NEW.page_id
     AND id NOT IN (
       SELECT id FROM revisions
        WHERE page_id = NEW.page_id
        ORDER BY created_at DESC, id DESC
        LIMIT 200
     );
  RETURN NULL; -- AFTER trigger: return value is ignored
END;
$$;

DROP TRIGGER IF EXISTS revisions_prune ON revisions;
CREATE TRIGGER revisions_prune
  AFTER INSERT ON revisions
  FOR EACH ROW
  EXECUTE FUNCTION prune_revisions();
