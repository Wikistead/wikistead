-- ADR-105 / #225: the vim ⇄ system-clipboard mode (cross-device), mirroring editor_keymap
-- (migration 025) and editor_display_mode (029). How vim's p/P relate to the OS clipboard:
--   'off'   — pure vim: registers and the OS clipboard stay separate ("+y / "+p are the only
--             bridge). Default when NULL.
--   'paste' — a plain p/P READS the system clipboard (and the paste flows through the shared
--             linkify path, #223); y/d/x/c never write it (no clobber).
-- (A 'full' unnamed⇄clipboard sync mode was ruled OUT on #225/— the engine has no
-- stable seam for it; if it ever returns it is a new ADR, not a new enum value slipped in.)
-- Self-scope: written only by the authenticated member for their OWN row + tenant RLS.
ALTER TABLE members ADD COLUMN editor_vim_clipboard TEXT;
