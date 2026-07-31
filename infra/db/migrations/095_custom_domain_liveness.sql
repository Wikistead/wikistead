-- #576 / ADR-065: a domain that was verified once can stop being ours later (DNS moved, the tunnel
-- died, the service was cancelled). Nothing re-checked, so `tenantBaseUrl` kept building links on a
-- host that no longer answers — the unsubscribe link in every notification mail pointed at a dead
-- name, silently. These two columns let a periodic re-verification demote a domain instead of
-- leaving the canonical URL wrong: consecutive failures are counted (a single DNS hiccup must not
-- unpick a customer's domain) and the last successful check is remembered as the grace anchor.
ALTER TABLE custom_domains ADD COLUMN check_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_domains ADD COLUMN last_checked_at TIMESTAMPTZ;
