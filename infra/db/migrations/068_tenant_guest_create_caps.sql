-- #274 / ADR-135 §3-§4: guest CREATE-page + attachment caps (business ruling 2), the same
-- fixed-window two-bucket pattern as migration 066 (#328) — all _max columns are PER-WINDOW rates
-- (reset each API_RATE_LIMIT_WINDOW_S), not lifetime totals: per share-LINK and per anon SESSION,
-- NULL = unlimited (self-host permissive default; Cloud sets real values). These are operational
-- tenant settings like the other abuse knobs — NOT a second entitlement layer (ADR-135 §3 note).
-- The guest per-file attachment size cap is a plain byte ceiling checked at confirm time (the
-- authoritative HeadObject size), NULL = unlimited. Members are never capped by any of these.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS abuse_create_page_link_max INTEGER;     -- NULL = unlimited
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS abuse_create_page_session_max INTEGER;  -- NULL = unlimited
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS abuse_attach_count_link_max INTEGER;    -- NULL = unlimited
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS abuse_attach_count_session_max INTEGER; -- NULL = unlimited
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS abuse_attach_guest_max_bytes BIGINT;    -- NULL = unlimited
