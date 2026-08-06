-- Migration 116 (#637 / ADR-216 §4): which spaces a narrowed API key may reach.
--
-- Same three states as `capabilities`, for the same reason. NULL is "not confined by space" — every
-- existing key, and the only state a CE deployment can produce. An empty array is "confined to no space
-- at all", which reaches nothing. Reading the two alike would open every space to the second.
--
-- The column lives here for the reason 114 gives: the ROW has to outlive the overlay. A key issued while
-- EE was present must keep being refused once it is removed, not widen back to its owner's full rights —
-- a leaked credential growing when a package is uninstalled is the wrong direction. What the list MEANS
-- (which resources it covers, how a page maps to a space) is registered from the EE composition root,
-- and with nothing registered the primitives refuse rather than guess.
--
-- `space_ids`, not a join table: it is a short list read on every request by primary key, it is written
-- once when the key is issued, and it is never queried the other way round ("which keys reach space S"
-- is a question nobody asks). A join table would buy referential integrity for a list whose entries are
-- allowed to go stale — a space deleted after the key was issued is simply a space the key cannot reach,
-- which is what an unresolvable id already answers.
ALTER TABLE api_keys ADD COLUMN space_ids text[];

COMMENT ON COLUMN api_keys.space_ids IS 'NULL = not confined by space; [] = confined to nothing (#637 / ADR-216 §4)';
