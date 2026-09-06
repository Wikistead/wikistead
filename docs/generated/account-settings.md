<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Source: apps/server/src/settings-catalog.ts.
  Regenerate: pnpm docs:gen   ·   Verify (CI): pnpm docs:check
  The "code is truth" account-settings reference.
-->

# Account settings

## Editor keymap (startup mode, cross-device)

| Value | Meaning |
|---|---|
| `default` | Always start in non-vim mode. |
| `vim` | Always start in vim mode (the toolbar toggle still switches for the session). |
| `local` | Follow this device's last toolbar choice (the default). |

## Editor display mode (startup, cross-device)

| Value | Meaning |
|---|---|
| `live` | Always start in Live preview. |
| `source` | Always start in Source mode. |
| `wysiwyg` | Always start in WYSIWYG (hidden-syntax) mode. |
| `local` | Follow this device's last choice (the default). |

## Vim system clipboard (cross-device)

| Value | Meaning |
|---|---|
| `off` | Pure vim: registers and the OS clipboard stay separate; `"+y` / `"+p` are the only bridge (the default). |
| `paste` | A plain `p` / `P` pastes the system clipboard (URLs auto-linkify like Ctrl+V); `y`/`d` never write it. |

## Mail language (mail only, not the app UI)

| Value | Meaning |
|---|---|
| `en` | Mail from this workspace is written in English. |
| `ja` | Mail from this workspace is written in Japanese. |
| `de` | Mail from this workspace is written in German. |

Unset falls back to the workspace default, then English.

## Custom key bindings

Rebindable commands: `editor.toggleVim`, `search.focus`, `palette.next`, `palette.prev`.

Reserved (never bindable — browser-owned): `Mod-w`, `Mod-n`, `Mod-t`, `Ctrl-w`, `Ctrl-n`, `Ctrl-t`.
