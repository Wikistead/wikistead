// #384 / #223 / ADR-037: the SINGLE URL-scheme XSS judgment for the whole renderer. Both markdown sinks — the
// editor's DOM walker (apps/web md-render.ts) and this package's SafeHtml walker (render.ts) — used to keep a
// hand-mirrored copy of this function, so an XSS-policy change had to be made in two places (the exact
// double-maintenance #384 is about). It lives here, in the DOM-free render boundary, so every link href goes
// through ONE judge. Also reused by the editor's paste-linkify + cell-link helpers (one scheme check, not three).
//
// Policy (blocklist, not allowlist — CommonMark permits relative/fragment/mailto/custom schemes):
//   1. strip a surrounding <…> (CommonMark angle-bracket destinations arrive WITH the brackets from the parser;
//      without this a `<javascript:…>` only failed to fire by accident — the literal `<` made it "relative").
//   2. remove the control chars a browser IGNORES inside a URL (C0 U+0000–U+001F + DEL U+007F, incl. TAB/LF/CR/
//      NUL) BEFORE evaluating the scheme — else `java\tscript:` slips past the blocklist yet executes once the
//      browser drops the tab. Matching the browser's normalization closes that.
//   3. block the dangerous schemes; allow everything else.
// Returns the sanitized href, or null if it must NOT become a live `href` (render as inert text instead).

// Built from code points so no literal control bytes live in this source file.
const URL_CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`, "g");

export function safeHref(url: string): string | null {
  let u = url.trim();
  if (u.length >= 2 && u.startsWith("<") && u.endsWith(">")) u = u.slice(1, -1); // angle-bracket destination
  u = u.replace(URL_CONTROL_CHARS, ""); // C0 controls + DEL (the chars browsers ignore inside a URL)
  if (/^\s*(javascript|data|vbscript|file):/i.test(u)) return null;
  const trimmed = u.trim();
  return trimmed || null;
}
