-- Migration 056: per-page :::todo task-progress aggregate for the sidebar ring (#290 / ADR-114 increment).
--
-- ADR-114: the sidebar tree shows a small progress ring ONLY on pages that contain a :::todo block.
-- Re-parsing published_md on every tree fetch is too heavy (the tree query deliberately skips published_md,
-- pages.ts:75), so persist the aggregate: task_done / task_total count the GFM checkboxes INSIDE :::todo
-- blocks of the PUBLISHED snapshot. task_total > 0 is self-gating — it is true exactly when the page has a
-- :::todo with tasks, so the sidebar shows the ring for those pages only. Display-only counters: webhooks /
-- search sync do NOT react to them. Recomputed on EVERY published_md write (publishPage AND toggleTask).
-- Defaults 0 = no ring until a page is (re)published with a :::todo — existing rows backfill lazily on their
-- next publish/toggle (a one-off SQL backfill is unnecessary: 0/0 renders no ring, the safe default).
ALTER TABLE pages ADD COLUMN IF NOT EXISTS task_done  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS task_total INTEGER NOT NULL DEFAULT 0;
