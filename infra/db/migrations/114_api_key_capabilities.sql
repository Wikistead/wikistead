-- Migration 114 (#628 / ADR-215 §2): what a narrowed API key may do.
--
-- NULL means "not narrowed" — the state every existing key is in, and the only state a CE deployment can
-- produce (narrowing is EE). An empty array is a different thing: a key narrowed to nothing, which may
-- reach no route at all. Reading the two the same way would open everything to the second.
--
-- The column lives in CE because the ROW has to: a key issued while an EE overlay was present must keep
-- being refused after it is removed, not silently widen to its owner's full rights. The decision about
-- what the list ALLOWS is what lives on the EE side (`registerNarrowedKeyGate`); with nothing
-- registered the request path refuses a narrowed key outright rather than guessing.
ALTER TABLE api_keys ADD COLUMN capabilities text[];

COMMENT ON COLUMN api_keys.capabilities IS 'NULL = not narrowed; [] = narrowed to nothing (#628 / ADR-215 §2)';
