import type { MarkdownConfig, DelimiterType } from "@lezer/markdown";

// #334 / ADR-129: highlight (`==text==` → <mark>) as a custom @lezer/markdown inline delimiter extension.
// There is no GFM/built-in Highlight, so this is authored exactly like the built-in Strikethrough (`~~`):
// a paired delimiter over a run of the marker char, with the same flanking rules. Kept here in the DOM-free
// macro-render package (no `document`/`window`) so ALL THREE parser sites share ONE source of truth —
// the CM6 editor (markdown-config.ts), the browser DOM renderer (md-render.ts), and this server export
// renderer (render.ts) — instead of the delimiter drifting between surfaces (which would leave `==foo==`
// literal on published/static pages). Display/rendering is per-surface; the GRAMMAR is shared.

const HighlightDelim: DelimiterType = { resolve: "Highlight", mark: "HighlightMark" };

// ASCII punctuation, matching the flanking test @lezer/markdown uses for Strikethrough (a local copy so we
// don't reach for the library's non-exported internal). Sufficient for the `==` open/close decision.
const PUNCT = /[!-/:-@[-`{-~]/;

export const highlightExtension: MarkdownConfig = {
  defineNodes: [{ name: "Highlight" }, { name: "HighlightMark" }],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        // Exactly two `=` (61). A lone `=` or a run of three+ (`===`) is not a highlight delimiter.
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = PUNCT.test(before);
        const pAfter = PUNCT.test(after);
        // Same open/close flanking as GFM Strikethrough: can-open when not followed by space (and either not
        // punctuation, or preceded by space/punctuation); can-close symmetrically. Prevents `= =` etc.
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter && (!pAfter || sBefore || pBefore), !sBefore && (!pBefore || sAfter || pAfter));
      },
      // After Emphasis so `*` / `_` resolve first, mirroring Strikethrough's ordering.
      after: "Emphasis",
    },
  ],
};
