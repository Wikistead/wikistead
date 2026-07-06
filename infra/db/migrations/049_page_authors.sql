-- Migration 049: page creator + last-publisher attribution (#222 / comment 824, option A).
--
-- The title-bar metadata row ("created by X · updated by Y · <time>") needs WHO created the page and WHO
-- last published it — neither was recorded on `pages` (only `updated_at`, and `revisions.created_by` per
-- publish). Add two nullable attribution columns holding the actor's identity `sub` (resolved to
-- name/avatar via the members directory, like every other author chip):
--   created_by  — set once, at page creation, to the creator's sub (never changes).
--   updated_by  — set on PUBLISH to the publisher's sub (option A: "updated" = the save-confirming act).
--                 Draft edits / renames / reorders do NOT touch it, so it never flickers per keystroke and
--                 needs no editor-identity plumbing through the collab persist path (single-Y.Text invariant
--                 untouched). Both NULL on pre-existing rows (rendered as "unknown"/omitted client-side).
ALTER TABLE pages ADD COLUMN created_by TEXT;
ALTER TABLE pages ADD COLUMN updated_by TEXT;
