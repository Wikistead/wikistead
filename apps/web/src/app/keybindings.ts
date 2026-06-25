// Remappable keyboard shortcuts (ADR-021). A small registry of the curated CHORD
// commands + helpers to (a) turn a KeyboardEvent into a normalized chord string using
// event.code (JIS / AltGr robust — the same reason the vim `\` binding uses code), and
// (b) resolve the effective key for a command from the user's overrides. Structural /
// contextual keys and vim's own keymap are NOT here.

export interface CommandDef {
  id: string;
  labelKey: string; // i18n key for the human label
  defaultKey: string; // CodeMirror/Mod-style chord string
}

// The window-level chord commands exposed in the rebinding UI today. `palette.next/prev`
// are also remappable per ADR-021 and accepted by the server, but their wiring lives in
// the CodeMirror palette keymap (+ the vim-beating domhandler) and is deferred to a
// follow-up; defaults (Ctrl-j/k) stand until then. Keep their defaults here so resolveKey
// works if a value ever arrives.
export const COMMANDS: CommandDef[] = [
  { id: "editor.toggleVim", labelKey: "account.cmd_toggleVim", defaultKey: "Ctrl-Alt-v" },
  { id: "search.focus", labelKey: "account.cmd_searchFocus", defaultKey: "Mod-k" },
];
const DEFAULTS: Record<string, string> = { "palette.next": "Ctrl-j", "palette.prev": "Ctrl-k" };

// Keys the browser owns — a page cannot intercept them (kept in sync with the server's
// RESERVED_KEYS). The capture UI rejects these; the server is the bastion.
export const RESERVED_KEYS = ["Mod-w", "Mod-n", "Mod-t", "Ctrl-w", "Ctrl-n", "Ctrl-t"];

export type Keybindings = Record<string, string>;

export function resolveKey(id: string, overrides: Keybindings | undefined): string {
  const def = COMMANDS.find((c) => c.id === id)?.defaultKey ?? DEFAULTS[id] ?? "";
  return overrides?.[id] ?? def;
}

// The base (non-modifier) key from event.code, lowercased/ascii so the chord is stable
// across layouts (KeyV→"v", Digit1→"1", Comma→","). null for a pure modifier press.
function codeToBase(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code; // F1..F12
  const sym: Record<string, string> = {
    Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";",
    Quote: "'", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`",
    Enter: "Enter", Space: "Space",
  };
  return sym[code] ?? null;
}

// A normalized chord from a KeyboardEvent (fixed modifier order). null if only modifiers
// are held (so the capture UI ignores them until a real key arrives).
export function chordFromEvent(e: KeyboardEvent): string | null {
  const base = codeToBase(e.code);
  if (!base) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(base);
  return parts.join("-");
}

// Does an event match a chord string? Handles "Mod-" (Ctrl on win/linux, Meta on mac) by
// accepting either. Used by the window-level handlers (toggleVim / search.focus). The CM
// palette keymap consumes the chord string directly (CM parses Mod/Ctrl/Alt natively).
export function eventMatches(e: KeyboardEvent, chord: string): boolean {
  const fromEvent = chordFromEvent(e);
  if (!fromEvent) return false;
  if (fromEvent === chord) return true;
  // Normalize a "Mod-" chord to whichever primary modifier this event used.
  if (chord.startsWith("Mod-")) {
    const rest = chord.slice(4);
    return fromEvent === `Ctrl-${rest}` || fromEvent === `Meta-${rest}`;
  }
  return false;
}

// Human-readable display for a chord (⌘/⌥ on mac-ish, else Ctrl/Alt). Display only.
export function displayChord(chord: string): string {
  return chord
    .replace(/\bMod\b/, "Ctrl/⌘")
    .split("-")
    .map((p) => (p.length === 1 ? p.toUpperCase() : p))
    .join("+");
}

// Client-side validation (mirrors the server bastion): non-empty, not browser-reserved,
// not a duplicate of another command's effective key. Returns an error key or null.
export function validateAssignment(id: string, chord: string, current: Keybindings): string | null {
  if (!chord) return "account.kbEmpty";
  if (RESERVED_KEYS.includes(chord)) return "account.kbReserved";
  for (const c of COMMANDS) {
    if (c.id === id) continue;
    if (resolveKey(c.id, current) === chord) return "account.kbDuplicate";
  }
  return null;
}
