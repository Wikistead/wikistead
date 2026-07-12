import type { MarkdownConfig, DelimiterType } from "@lezer/markdown";

// #334 / ADR-129: highlight (`==text==` → <mark>) as a custom @lezer/markdown inline delimiter extension.
// There is no GFM/built-in Highlight, so this is a paired delimiter over a run of the marker char. Kept here
// in the DOM-free macro-render package (no `document`/`window`) so ALL THREE parser sites share ONE source of
// truth — the CM6 editor (markdown-config.ts), the browser DOM renderer (md-render.ts), and this server export
// renderer (render.ts) — instead of the delimiter drifting between surfaces (which would leave `==foo==`
// literal on published/static pages). Display/rendering is per-surface; the GRAMMAR is shared.
//
// #334 review (comment 1519): the delimiter follows markdown-it-mark's can-split-word rule, NOT GFM
// Strikethrough's stricter flanking. The strikethrough rule refuses to OPEN when the `==` is immediately
// followed by punctuation with a word char before it — so `word==**bold**==word` left the `==` literal (the
// `**` counts as punctuation after the opening `==`). markdown-it-mark (the de-facto `==` standard, Obsidian /
// HackMD) opens/closes intraword and next to punctuation; the only bar is a whitespace-adjacent delimiter
// (`a == b` must stay literal). So: can-open ⟺ not followed by whitespace; can-close ⟺ not preceded by
// whitespace. (`~~` keeps GFM's flanking — that's a separate grammar and out of this ticket's scope.)

const HighlightDelim: DelimiterType = { resolve: "Highlight", mark: "HighlightMark" };

export const highlightExtension: MarkdownConfig = {
  defineNodes: [{ name: "Highlight" }, { name: "HighlightMark" }],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        // Exactly two `=` (61). A lone `=` or a run of three+ (`===`) is not a highlight delimiter.
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const sBefore = /\s|^$/.test(cx.slice(pos - 1, pos));
        const sAfter = /\s|^$/.test(cx.slice(pos + 2, pos + 3));
        // markdown-it-mark can-split-word: open unless a space follows; close unless a space precedes. This
        // allows `word==**bold**==word` and intraword `a==b==c`, while `a == b` (space-flanked) stays literal.
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter, !sBefore);
      },
      // After Emphasis so `*` / `_` resolve first, mirroring Strikethrough's ordering.
      after: "Emphasis",
    },
  ],
};
