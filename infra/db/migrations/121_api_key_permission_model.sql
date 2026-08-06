-- Migration 121 (#667 / ADR-221 §3): which permission model a key is read by, and what it holds.
--
-- ADR-221 replaces six borrowed role verbs with twenty-one resource types, each read or write. That
-- change cannot be applied to keys already issued: old `view` reaches eight routes and new `pages: read`
-- reaches every page-read route, so ANY mapping hands an existing key routes it could not reach
-- yesterday. The widening would not be a bug in the mapping — it is the route table growing, happening
-- to credentials nobody re-issued.
--
-- So keys are not remapped. `permission_model` says which rule reads a row, and a v1 key is evaluated by
-- the v1 verbs against the v1 route table for as long as it lives. That is a deliberate deviation from
-- the ticket's fourth requirement ("define the mapping"), taken because the mapping cannot exist without
-- widening, and disclosed as such.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS permission_model smallint NOT NULL DEFAULT 1;

-- A SEPARATE column, not a reuse of `capabilities`. The v1 rule reads `capabilities` as a list of verbs
-- and is frozen; writing resource types into it would have the frozen rule interpreting v2 values as
-- verbs, which is silent and wrong in the permissive direction (an unknown verb satisfies nothing, so
-- `rule.every(...)` over an empty rule passes).
--
-- Shape: `{"pages": "read", "members": "write"}`. A type absent from the object is `none`, which is the
-- default for every type — the same three-state reasoning as `capabilities` and `space_ids`, one level
-- down: NULL is "carries no matrix" (a v1 key, or an unnarrowed one), `{}` is "narrowed to nothing".
-- `IF NOT EXISTS` on both: this file was briefly numbered 120 and collided with another
-- session's migration of that number. Anyone whose database applied the earlier name already has the
-- columns, and re-running must be a no-op rather than a crash on startup.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS permissions jsonb;

COMMENT ON COLUMN api_keys.permission_model IS '1 = the six v1 verbs against the frozen route table; 2 = the resource-type matrix in `permissions` (#667 / ADR-221 §3)';
COMMENT ON COLUMN api_keys.permissions IS 'NULL = no matrix (v1, or unnarrowed); {} = narrowed to nothing; {"type": "read"|"write"} otherwise (#667 / ADR-221 §1)';
