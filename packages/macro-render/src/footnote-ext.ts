import type { MarkdownConfig } from "@lezer/markdown";

// #335 / ADR-130: footnote notation — an inline reference `[^label]` and a block definition line
// `[^label]: body`. Like ADR-129's highlight, the GRAMMAR lives once (DOM-free, here) and is registered at
// every parser site so the surfaces don't drift. The RESOLUTION (reference↔definition matching, first-reference
// numbering, end-of-document collection with back-links) is done per-surface over these nodes — this file only
// recognises the two shapes. Precedence (review B): the ref parser runs BEFORE `Link` and the def
// parser BEFORE `LinkReference`, and both match ONLY when a `[` is immediately followed by `^`, so a real
// `[text](url)` / `[ref][id]` / link-reference-definition still parses normally.

// A label char run: anything up to the closing `]` (no nested `[`, no whitespace-only). Kept simple —
// `[^label]` where label is a non-empty run without `]` or `[`.
export const footnoteExtension: MarkdownConfig = {
  defineNodes: [
    { name: "FootnoteRef" },
    { name: "FootnoteDef", block: true },
    { name: "FootnoteDefMark" },
  ],
  parseInline: [
    {
      name: "FootnoteRef",
      parse(cx, next, pos) {
        // `[^` only; then a non-empty label run up to `]` (no nested `[`).
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 94 /* ^ */) return -1;
        let i = pos + 2;
        while (i < cx.end && cx.char(i) !== 93 /* ] */ && cx.char(i) !== 91 /* [ */) i++;
        if (i >= cx.end || cx.char(i) !== 93 || i === pos + 2) return -1; // no closing ] / empty label
        return cx.addElement(cx.elt("FootnoteRef", pos, i + 1));
      },
      before: "Link", // beat Link's `[` handling so `[^1]` is never a shortcut/reference link
    },
  ],
  parseBlock: [
    {
      name: "FootnoteDef",
      // Eager leaf: a line beginning `[^label]:` is a footnote definition. Single-line in v1 (no lazy
      // continuation) — the body is the rest of the line, inline-parsed.
      parse(cx, line) {
        // Must be at the block's left margin (line.pos points past indentation/markers).
        const rest = line.text.slice(line.pos);
        const m = /^\[\^([^\]\s]+)\]:[ \t]?/.exec(rest);
        if (!m) return false;
        const from = cx.lineStart + line.pos;
        const markTo = from + m[0].length;
        const to = cx.lineStart + line.text.length;
        // The `[^label]:` marker is a skippable node; the trailing body is inline content of the def.
        const bodyChildren = markTo < to ? cx.parser.parseInline(line.text.slice(line.pos + m[0].length), markTo) : [];
        cx.addElement(cx.elt("FootnoteDef", from, to, [cx.elt("FootnoteDefMark", from, markTo), ...bodyChildren]));
        cx.nextLine();
        return true;
      },
      before: "LinkReference", // beat the link-reference-definition parser for `[^label]:`
    },
  ],
};
