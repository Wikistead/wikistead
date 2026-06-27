import type { MarkdownConfig } from "@lezer/markdown";

// Minimal in-house lezer parser for CommonMark container directives:
//
//   :::name{attrs}
//   ...markdown content...
//   :::
//
// This is the "one structural piece of new infrastructure" ADR-017/022 anticipated:
// no permissive off-the-shelf lezer directive extension exists, so we add a minimal
// one, isolated here and wired in one place (markdown-config.ts). It is a COMPOSITE
// block: the content between the fences is parsed as normal Markdown (nested), so the
// existing live-preview renderers decorate it for free and the source round-trips
// (the `:::` lines are plain text). Leaf/inline directives (::name, :name[…]) are a
// later addition; M1 needs only the container form (e.g. :::callout).

const COLON = 58; // ':'

// Opening fence: 3+ colons, a name, an optional leading [label] (remark-directive style; the
// FIRST [..]). Returns the colon count + name + label. Backward compatible: no [label] → no
// `label` field. TRAILING content after the name/label is TOLERATED — the whole line is consumed
// as a DirectiveMark (parseBlock below), so a label's `[..]` (or any stray `]`) is never left to
// Markdown inline parsing. #94 bug: the old strict `$` made `:::callout[a]b]` (and any `:::name
// [label] trailing`) FAIL to match → the line fell back to a paragraph and `[a]` was linkified.
export function parseDirectiveOpen(text: string): { colons: number; name: string; label?: string } | null {
  const m = /^(:{3,})[ \t]*([A-Za-z][\w-]*)[ \t]*(?:\[([^\]]*)\])?/.exec(text);
  if (!m) return null;
  const out: { colons: number; name: string; label?: string } = { colons: m[1]!.length, name: m[2]! };
  const label = m[3]?.trim();
  if (label) out.label = label;
  return out;
}

// Closing fence: only colons (>= the opening count), nothing else.
export function isDirectiveClose(text: string, minColons: number): boolean {
  const m = /^(:{3,})[ \t]*$/.exec(text);
  return !!m && m[1]!.length >= minColons;
}

export const directiveExtension: MarkdownConfig = {
  defineNodes: [
    {
      name: "Directive",
      block: true,
      // Continue the composite block each line until the closing fence. The fence
      // lines become DirectiveMark nodes; everything between is nested Markdown.
      composite(cx, line, value) {
        const text = line.text.slice(line.pos);
        if (isDirectiveClose(text, value)) {
          line.addMarker(cx.elt("DirectiveMark", cx.lineStart + line.pos, cx.lineStart + line.text.length));
          line.moveBase(line.text.length); // consume the closing fence
          return false; // end the directive
        }
        return true; // content line → parsed as Markdown inside the Directive
      },
    },
    { name: "DirectiveMark" },
  ],
  parseBlock: [
    {
      name: "Directive",
      before: "FencedCode", // a ::: line must win before generic block parsing
      parse(cx, line) {
        const open = parseDirectiveOpen(line.text.slice(line.pos));
        if (!open) return false;
        const from = cx.lineStart + line.pos;
        cx.startComposite("Directive", line.pos, open.colons);
        cx.addElement(cx.elt("DirectiveMark", from, cx.lineStart + line.text.length));
        line.moveBase(line.text.length); // consume the opening fence line
        return null; // composite started
      },
    },
  ],
};
