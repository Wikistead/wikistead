-- #364 / ADR-157: the space homepage is a POINTER at a regular page — no page kind, no new FGA
-- surface. Composite cross-tenant FK (the 002 convention: FK checks bypass RLS, so a single-column
-- FK could point at another tenant's row). ON DELETE SET NULL is deliberate and a first in this
-- schema: deleting the home page degrades the space to the empty state instead of cascading.
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS home_page_id TEXT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spaces_home_page_fk'
  ) THEN
    ALTER TABLE spaces ADD CONSTRAINT spaces_home_page_fk
      FOREIGN KEY (tenant_id, home_page_id) REFERENCES pages (tenant_id, id)
      ON DELETE SET NULL (home_page_id);
  END IF;
END $$;
