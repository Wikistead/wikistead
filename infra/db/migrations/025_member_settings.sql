-- ADR-020 user account settings. Personal-scope preferences on the per-tenant member row:
--   display_name_override     — the user's chosen name; NULL = use the OIDC display_name.
--                               A SEPARATE column so the login upsert (which writes
--                               display_name from the IdP) never clobbers a custom name.
--   avatar_image_key / _ct    — uploaded avatar in object storage (mirrors the space icon:
--                               the KEY lives in the DB, the bytes in storage). NULL =
--                               fall back to the OIDC picture, then a deterministic
--                               initials avatar.
--   editor_keymap             — 'default' | 'vim'. Server-synced so the choice follows the
--                               user across devices (the client hydrates from localStorage
--                               first to avoid a flash, then reconciles with this value).
-- Self-scope: written only by the authenticated member for their OWN row
-- (WHERE sub = req.user.sub) + tenant RLS; this is identity, not an FGA resource ACL.
ALTER TABLE members ADD COLUMN display_name_override TEXT;
ALTER TABLE members ADD COLUMN avatar_image_key TEXT;
ALTER TABLE members ADD COLUMN avatar_image_content_type TEXT;
ALTER TABLE members ADD COLUMN editor_keymap TEXT;
