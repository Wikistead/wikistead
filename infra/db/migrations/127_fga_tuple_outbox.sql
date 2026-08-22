-- Migration 127 (#896 / ADR-255 Decision 5): the durable queue for tuple DELETES.
--
-- A member removal deletes the member's rows and their permission-store tuples. The tuple call can
-- fail while the transaction commits, and #378 chose deliberately to let it: a store outage must
-- never leave a removed member seated. The consequence was that the tuple stayed, naming a subject
-- (`user:<sub>`) on an object whose row is gone -- and ADR-255 section 1 shows nothing can find it
-- afterwards, because every sweep starts from a row.
--
-- So the intent is written down instead of forgotten. Enqueue-then-delete: the row is INSERTed in
-- the same transaction that removes the member, the store call happens AFTER commit, and success
-- deletes the row. Recording only what a `catch` saw would lose the crash between commit and call --
-- the one case a catch block cannot observe.
--
-- Ruled 2026-08-21: a row that keeps failing is NOT discarded. It waits, and the drain publishes how
-- many are waiting and how old the oldest is. A queue that drops what it cannot deliver reports
-- success while the residue it exists to remove accumulates.
--
-- No RLS, like its six siblings (search, email, webhook, import, and EE's audit and analytics): this
-- is a shared-pool processing table drained by a worker that carries no tenant. A drain that cannot
-- see its own rows is the failure mode, so the grants are explicit.
CREATE TABLE IF NOT EXISTS fga_tuple_outbox (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id   TEXT NOT NULL,
  -- The tuple, spelled as the store spells it. Stored as three columns rather than JSON so a person
  -- reading the queue can see WHICH subject is still named on WHICH object -- that legibility is the
  -- point of the table, and it is what the data-subject erasure path (#897) searches on.
  subject     TEXT NOT NULL,
  relation    TEXT NOT NULL,
  object      TEXT NOT NULL,
  claimed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The claim orders by created_at (FIFO, the lease primitive's default) and filters on claimed_at.
CREATE INDEX IF NOT EXISTS fga_tuple_outbox_due_idx ON fga_tuple_outbox (created_at) WHERE claimed_at IS NULL;
-- #897 searches by subject to answer a data-subject request; it is the only other reader.
CREATE INDEX IF NOT EXISTS fga_tuple_outbox_subject_idx ON fga_tuple_outbox (subject);
GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE fga_tuple_outbox TO app;
