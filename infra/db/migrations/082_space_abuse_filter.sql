-- #509 / ADR-187: per-space moderation policy — a space MAY layer ADDITIVE strictness on top of the
-- tenant abuse floor (banned words are UNIONed; shrink ratio is the STRICTER of the two). A space can
-- never WEAKEN the tenant floor (the resolver takes union / max). NULL = inherit (no space layer), the
-- same inherit convention as delete_mode (migration 076). The existing space_settings GRANT/RLS
-- (migration 018) covers these columns.
ALTER TABLE space_settings ADD COLUMN IF NOT EXISTS abuse_shrink_ratio REAL; -- NULL = inherit tenant floor
ALTER TABLE space_settings ADD COLUMN IF NOT EXISTS abuse_banned_words TEXT[]; -- NULL = inherit (no space additions)
