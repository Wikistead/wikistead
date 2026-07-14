-- #328 / ADR-140 increment 2: guest rate caps (publish + collab connect), fixed-window (ADR-063).
-- NULL = unlimited (the self-host permissive default; the Infinity short-circuit does zero Valkey I/O).
-- Two maxes per surface: per share-LINK (bounds the whole link) and per anon SESSION (#331 pseudonymous id
-- — bounds ONE guest within a link so an abuser can't consume co-editors' budget). For the isolation to be
-- meaningful the session max should be set below the link max; both are per the shared fixed window
-- (API_RATE_LIMIT_WINDOW_S). Keys never use raw IP (ADR-140 I1 / ADR-138). The existing tenant_settings
-- GRANT/RLS (migration 019) covers these.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS abuse_publish_rate_link_max INTEGER;    -- NULL = unlimited
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS abuse_publish_rate_session_max INTEGER; -- NULL = unlimited
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS abuse_connect_rate_link_max INTEGER;    -- NULL = unlimited
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS abuse_connect_rate_session_max INTEGER; -- NULL = unlimited
