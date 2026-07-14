-- Migration 067: watch scopes & notification preferences (#362 / ADR-126 addendum 2026-07-14).
--
-- All EMISSION-narrowing knobs (never an authorization input — the read path's double gate stays the
-- sole permission authority). Permissive defaults: empty mask = all event types, unmuted, member
-- notifications on — a pre-#362 install sees zero behavior change.

-- Per-watch: event-type mask (empty = all / fall back to the member default), mute (keeps the row +
-- its mask but silences fan-out — distinct from unwatch), and the new 'subtree' scope (an ancestor
-- page watch matching every descendant page event via the pages.parent_id chain).
ALTER TABLE watches ADD COLUMN IF NOT EXISTS event_mask TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE watches ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE watches DROP CONSTRAINT IF EXISTS watches_resource_type_check;
ALTER TABLE watches ADD CONSTRAINT watches_resource_type_check CHECK (resource_type IN ('page', 'space', 'subtree'));

-- Member defaults (ADR-020 self-scope account settings — members-table direct columns, same as
-- editor_keymap): a global notifications kill switch + the default event mask a mask-less watch
-- inherits. Both read by the set-based fan-out in the same statement (LEFT JOIN members).
ALTER TABLE members ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE members ADD COLUMN IF NOT EXISTS default_event_mask TEXT[] NOT NULL DEFAULT '{}';
