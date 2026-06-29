-- Migration 034: revision-GC orphan-candidate bookkeeping (#113 / ADR-062).
--
-- The reconciling revision GC must NEVER delete a referenced blob (the data-loss crux). It
-- works in TWO stages: a storage object with no live `revisions.ydoc_key` is first MARKED here
-- (first_seen recorded); only on a LATER run, if it is STILL orphan AND past a grace window, is
-- it deleted. This grace + two-stage scheme means a just-written blob (key put, revision row not
-- yet committed) is never mistaken for an orphan — by the next run its row exists and it is live.
--
-- Admin/GC-internal bookkeeping ONLY (the cross-tenant GC runs as the admin role); keys are
-- already tenant-prefixed, and the runtime 'app' role never touches this table, so no RLS/GRANT.
CREATE TABLE revision_gc_candidates (
  ydoc_key   TEXT PRIMARY KEY,             -- the storage key seen with no live DB pointer
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);
