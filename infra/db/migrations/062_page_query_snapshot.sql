-- #353 / ADR-134 rev2 (Hole A): the anonymous static snapshot for a page's `:::query` blocks.
-- The public/guest surface never triggers a live per-viewer reverse-lookup (the #244 re-entry class); instead,
-- at publish the page's queries are resolved ONCE as `user:anonymous` (published-only) and the ordered results
-- are baked here. The public route substitutes each `:::query` directive with its baked list at serve time.
-- Shape: { "v": 1, "blocks": [ { "spec": "<first body line>", "results": [ { "id": "...", "title": "..." } ] } ] }
-- in document order (aligned to resolveDirectiveRanges' query blocks over published_md). NULL = never published /
-- no query blocks. It is DISPLAY output derived from the published graph, never source (published_md is canonical
-- and still holds the literal `:::query` directive — Open formats).
ALTER TABLE pages ADD COLUMN IF NOT EXISTS published_query_snapshot JSONB;
