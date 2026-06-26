-- Migration 028: lightweight checkbox audit log (#97 / ADR-019 D2).
--
-- ADR-019 D2 deliberately keeps per-checkbox who/when OUT of the revision/diff history (a
-- toggle is interactive state, not content history). It named this OPTIONAL lightweight
-- `checkbox_events` log as the sanctioned way to add audit if ever wanted — separate from
-- revisions. One row per ACCEPTED toggle: who (FGA principal), which checkbox, new state, when.
CREATE TABLE IF NOT EXISTS checkbox_events (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id      TEXT NOT NULL,
  page_id        TEXT NOT NULL,
  actor          TEXT NOT NULL,        -- FGA principal: "user:<sub>" | "share_link:<id>"
  checkbox_index INT  NOT NULL,
  checked        BOOLEAN NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, page_id) REFERENCES pages(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS checkbox_events_page_idx ON checkbox_events (page_id, created_at);

ALTER TABLE checkbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkbox_events FORCE ROW LEVEL SECURITY;
-- USING doubles as the INSERT WITH CHECK, so a row can only be written under its own tenant.
CREATE POLICY tenant_isolation ON checkbox_events
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT ON TABLE checkbox_events TO app;
