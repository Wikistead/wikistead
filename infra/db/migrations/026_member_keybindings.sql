-- ADR-021 remappable shortcuts. Per-account keybinding overrides (cross-device),
-- self-scope (written only by the authenticated member for their OWN row,
-- WHERE sub = req.user.sub + tenant RLS — identity, not an FGA ACL). A JSONB map of
-- commandId → normalized chord string, e.g. {"editor.toggleVim":"Ctrl-Alt-v"}. NULL =
-- all defaults. Only a curated set of chord commands is remappable (editor.toggleVim /
-- search.focus / palette.next / palette.prev); structural/contextual keys and vim's own
-- keymap are NOT stored here.
ALTER TABLE members ADD COLUMN keybindings JSONB;
