-- ADR-056 / #164-3: the editor DISPLAY-MODE startup preference (cross-device), mirroring
-- editor_keymap (migration 025). How the editor opens its syntax visibility:
--   'live'    — always start in Live (reveal-on-cursor; the default rendering)
--   'source'  — always start in Source (syntax always raw)
--   'local'   — follow this device's last toolbar choice (localStorage). Default when NULL.
-- (reading / wysiwyg are display modes but not yet startup choices — phase 1 cycles live⇄source.)
-- Self-scope: written only by the authenticated member for their OWN row + tenant RLS.
ALTER TABLE members ADD COLUMN editor_display_mode TEXT;
