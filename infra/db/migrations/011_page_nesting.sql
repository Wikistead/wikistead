-- Migration 011: nested pages — parent composite FK + sibling ordering rank.
--
-- parent_id now references a same-tenant page. The composite (tenant_id,parent_id)
-- FK blocks cross-tenant nesting at the DB level (Postgres FK runs before RLS) —
-- same hardening as the space_id FK in 002. NULL parent_id = top-level page.
--
-- ON DELETE CASCADE removes a page's subtree in the DB. FGA-grant + search-index
-- cleanup for the cascaded descendants is done in the application delete path
-- (deletePage collects descendants first), so cascade can't leave ghost auth.
ALTER TABLE pages
  ADD CONSTRAINT pages_parent_fk
  FOREIGN KEY (tenant_id, parent_id) REFERENCES pages(tenant_id, id) ON DELETE CASCADE;

-- Fractional ordering key among siblings (same parent in the same space). A move
-- or reorder is a SINGLE-row UPDATE to a value between its new neighbours (front
-- = min-1, end = max+1, between = midpoint) — no sibling renumber, so concurrent
-- moves of different pages never corrupt order (same-page move is last-write-
-- wins). v1 uses a float midpoint; a periodic rebalance handles eventual
-- precision exhaustion (future). LexoRank-style string keys are a later refinement.
ALTER TABLE pages ADD COLUMN position DOUBLE PRECISION NOT NULL DEFAULT 0;
CREATE INDEX pages_sibling_order_idx ON pages (tenant_id, space_id, parent_id, position);
