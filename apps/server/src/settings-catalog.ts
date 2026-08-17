// "Code is truth" account-settings catalog (#139 / ADR-080 doc↔code linkage). A PURE leaf (no
// server deps) so it is the SINGLE source for BOTH the account route's validation AND the
// generated settings reference — a new option cannot be added to one without the other.

export type KeymapMode = 'default' | 'vim' | 'local'
export const KEYMAP_MODES: KeymapMode[] = ['default', 'vim', 'local']

// #289 / ADR-115: 'wysiwyg' joined the STARTUP set (the wysiwyg persona boots there; #168 shipped
// the mode). 'reading' stays deliberately non-startup — it is a mid-session display state.
export type DisplayModePref = 'live' | 'source' | 'wysiwyg' | 'local'
export const DISPLAY_MODE_PREFS: DisplayModePref[] = ['live', 'source', 'wysiwyg', 'local']

// ADR-105 / #225: vim register ⇄ system-clipboard mode. 'paste' makes a plain p/P read the OS
// clipboard (through the shared linkify path); yank/delete never write it. 'full' (unnamed register
// IS the clipboard) was ruled out on #225/ — the vim engine has no stable seam for it.
export type VimClipboardMode = 'off' | 'paste'
export const VIM_CLIPBOARD_MODES: VimClipboardMode[] = ['off', 'paste']

// #289 / ADR-115: the per-user editor CHROME VISIBILITY object (JSONB `members.editor_chrome`).
// Visibility ONLY — the startup mode stays in editor_display_mode (single source of truth, #2).
// null = never enrolled → all chrome shown. Validated strictly (unknown keys / non-booleans 400).
export interface EditorChromeVisibility {
  vimToggleVisible: boolean
  modesVisible: { live: boolean; source: boolean; reading: boolean; wysiwyg: boolean }
}
export const CHROME_MODES = ['live', 'source', 'reading', 'wysiwyg'] as const
export function validateEditorChrome(v: unknown): EditorChromeVisibility {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw Object.assign(new Error('invalid editorChrome'), { statusCode: 400 })
  const o = v as Record<string, unknown>
  if (Object.keys(o).sort().join(',') !== 'modesVisible,vimToggleVisible') throw Object.assign(new Error('invalid editorChrome keys'), { statusCode: 400 })
  if (typeof o.vimToggleVisible !== 'boolean') throw Object.assign(new Error('invalid vimToggleVisible'), { statusCode: 400 })
  const mv = o.modesVisible
  if (typeof mv !== 'object' || mv === null || Array.isArray(mv)) throw Object.assign(new Error('invalid modesVisible'), { statusCode: 400 })
  const mo = mv as Record<string, unknown>
  if (Object.keys(mo).sort().join(',') !== [...CHROME_MODES].sort().join(',')) throw Object.assign(new Error('invalid modesVisible keys'), { statusCode: 400 })
  for (const k of CHROME_MODES) if (typeof mo[k] !== 'boolean') throw Object.assign(new Error(`invalid modesVisible.${k}`), { statusCode: 400 })
  return { vimToggleVisible: o.vimToggleVisible, modesVisible: { live: mo.live as boolean, source: mo.source as boolean, reading: mo.reading as boolean, wysiwyg: mo.wysiwyg as boolean } }
}

// Remappable chord commands (ADR-021) — ONLY these may be rebound; structural/contextual keys
// (`/` `\` Enter/Esc/Tab, mnemonics, ex-commands) and vim's own keymap are fixed.
export const REMAPPABLE_COMMANDS = ['editor.toggleVim', 'search.focus', 'palette.next', 'palette.prev']
// Keys the browser owns — never bindable (defence-in-depth; the UI also blocks these).
export const RESERVED_KEYS = ['Mod-w', 'Mod-n', 'Mod-t', 'Ctrl-w', 'Ctrl-n', 'Ctrl-t']

const KEYMAP_DESC: Record<KeymapMode, string> = {
  default: 'Always start in non-vim mode.',
  vim: 'Always start in vim mode (the toolbar toggle still switches for the session).',
  local: "Follow this device's last toolbar choice (the default).",
}
const VIM_CLIPBOARD_DESC: Record<VimClipboardMode, string> = {
  off: 'Pure vim: registers and the OS clipboard stay separate; `"+y` / `"+p` are the only bridge (the default).',
  paste: 'A plain `p` / `P` pastes the system clipboard (URLs auto-linkify like Ctrl+V); `y`/`d` never write it.',
}
const DISPLAY_DESC: Record<DisplayModePref, string> = {
  live: 'Always start in Live preview.',
  source: 'Always start in Source mode.',
  wysiwyg: 'Always start in WYSIWYG (hidden-syntax) mode.',
  local: "Follow this device's last choice (the default).",
}

const HEADER = `<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Source: apps/server/src/settings-catalog.ts.
  Regenerate: pnpm docs:gen   ·   Verify (CI): pnpm docs:check
  The "code is truth" account-settings reference (ADR-080 doc↔code linkage).
-->`

// Deterministic Markdown for the account settings reference (cross-device startup preferences +
// the rebindable-keys contract). Generated from the same constants the server validates against.
export function renderAccountSettingsMarkdown(): string {
  const lines: string[] = [HEADER, '', '# Account settings', '']
  lines.push('## Editor keymap (startup mode, cross-device)', '', '| Value | Meaning |', '|---|---|')
  for (const m of KEYMAP_MODES) lines.push(`| \`${m}\` | ${KEYMAP_DESC[m]} |`)
  lines.push('', '## Editor display mode (startup, cross-device)', '', '| Value | Meaning |', '|---|---|')
  for (const m of DISPLAY_MODE_PREFS) lines.push(`| \`${m}\` | ${DISPLAY_DESC[m]} |`)
  lines.push('', '## Vim system clipboard (cross-device)', '', '| Value | Meaning |', '|---|---|')
  for (const m of VIM_CLIPBOARD_MODES) lines.push(`| \`${m}\` | ${VIM_CLIPBOARD_DESC[m]} |`)
  lines.push('', '## Custom key bindings', '')
  lines.push(`Rebindable commands: ${REMAPPABLE_COMMANDS.map((c) => `\`${c}\``).join(', ')}.`)
  lines.push('', `Reserved (never bindable — browser-owned): ${RESERVED_KEYS.map((k) => `\`${k}\``).join(', ')}.`)
  lines.push('')
  return lines.join('\n')
}
