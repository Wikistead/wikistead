-- Migration 050: durable share-link revoke-failure marker (#220, option A).
--
-- When a page/space is made private, revokeResourceShareLinks deletes each active link's FGA tuple and
-- stamps revoked_at. #109 recorded an FGA-delete FAILURE only in a log line (revoked_at stays NULL), which
-- is indistinguishable from a legitimate active link on a private page. #220 adds a DURABLE marker so a
-- periodic sweep can retry ONLY the genuinely-failed links — never re-deriving "failed" from
-- "private AND revoked_at IS NULL", which cannot tell a revoke-failure zombie from a legitimate active link
-- (share links are DIRECT grants, not cut by `but not private`, so a live link on a private page is normal).
--   revoke_failed_at — set when the FGA delete errored during revoke; cleared (and revoked_at set) once a
--                      sweep retry succeeds. NULL on every link that was never a revoke failure.
ALTER TABLE share_links ADD COLUMN revoke_failed_at TIMESTAMPTZ;

-- Partial index for the sweep's per-tenant lookup — indexes only the tiny set of pending-retry rows.
CREATE INDEX share_links_revoke_failed_idx ON share_links (tenant_id)
  WHERE revoke_failed_at IS NOT NULL AND revoked_at IS NULL;
