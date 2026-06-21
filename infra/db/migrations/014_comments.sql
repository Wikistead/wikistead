-- Migration 014: comments — page-level and inline (P4).
--
-- RLS RULE (see 001_tenants.sql): ENABLE + FORCE + policy + GRANT in this file.
--
-- Ancillary metadata, NOT embedded in the page Y.Text (the canon stays pure prose,
-- same as attachments/images). Comment bodies + metadata live here. An INLINE
-- thread additionally stores an OPAQUE Yjs RelativePosition (encoded bytes)
-- referencing a range in the page's Y.Text: the client creates and resolves it
-- (edit-following, exactly like remote carets — ADR-008); the server never
-- interprets it. If the anchored text is later deleted the position resolves to
-- nothing and the thread is shown as "anchor lost" using quoted_text — never lost.
--
-- Authorization is DERIVED from FGA page#comment / page#view per request. Comments
-- create NO FGA tuples — there is no per-comment FGA object — so there is no tuple
-- explosion at scale and no DB+FGA dual-write to keep consistent.

CREATE TABLE comment_threads (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id    TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'inline')),
  anchor_start BYTEA,                                  -- encoded Yjs RelativePosition (NULL for page kind)
  anchor_end   BYTEA,
  quoted_text  TEXT,                                   -- snapshot of anchored text (display + anchor-lost fallback)
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by  TEXT,
  resolved_at  TIMESTAMPTZ,
  UNIQUE (tenant_id, id),                              -- composite FK target
  FOREIGN KEY (tenant_id, page_id) REFERENCES pages(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX comment_threads_page_idx ON comment_threads (tenant_id, page_id, status);

CREATE TABLE comments (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id  TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  author_sub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at  TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,                              -- soft delete; the thread keeps its shape
  FOREIGN KEY (tenant_id, thread_id) REFERENCES comment_threads(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX comments_thread_idx ON comments (tenant_id, thread_id, created_at);

ALTER TABLE comment_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON comment_threads
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE comment_threads TO app;

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON comments
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE comments TO app;
