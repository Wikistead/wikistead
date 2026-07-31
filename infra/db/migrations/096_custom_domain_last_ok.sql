-- #576 re-review: 095 named `last_checked_at` the grace anchor, and the sweep then wrote it on
-- EVERY tick — including failing ones. So "time since the last success" was re-zeroed by the very
-- check that observed the failure, and with a 6h interval and a 24h window the anchor could never
-- elapse: the sweep counted failures forever and demoted nothing. Measured over 120 simulated
-- ticks (30 days of production interval): zero demotions.
--
-- Two columns, two meanings, neither doing the other's job: `last_checked_at` is when we last
-- LOOKED (observability — "is the worker alive?"), `last_ok_at` is when the domain was last proved
-- ours (the grace anchor, moved only by a success). Backfilled from verified_at, which is exactly
-- what the anchor was before any sweep ran.
ALTER TABLE custom_domains ADD COLUMN last_ok_at TIMESTAMPTZ;
UPDATE custom_domains SET last_ok_at = verified_at WHERE status = 'verified' AND last_ok_at IS NULL;
