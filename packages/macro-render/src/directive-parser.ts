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
// #393 / ADR-151 §0: the shared directive-ATTRIBUTE facility. `{key=val key2="v w"}` after the optional
// [label] (remark-directive / MyST / Pandoc common form). Keys are word-chars; a value is either bare
// (no spaces/braces/quotes) or double-quoted. Unknown keys are PRESERVED verbatim in the map (lossless
// round-trip — a consumer reads only the keys it knows; serializers re-emit what they parsed). Absent /
// empty `{}` → no `attrs` field (backward compatible: every existing consumer sees the same shape).
export function parseDirectiveAttrs(inner: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let any = false;
  const re = /([A-Za-z_][\w-]*)=(?:"([^"]*)"|([^\s"{}]+))/g;
  for (let m = re.exec(inner); m; m = re.exec(inner)) {
    out[m[1]!] = m[2] ?? m[3] ?? "";
    any = true;
  }
  return any ? out : undefined;
}

export function serializeDirectiveAttrs(attrs: Record<string, string> | undefined): string {
  if (!attrs) return "";
  const parts = Object.entries(attrs).map(([k, v]) => (/^[^\s"{}]+$/.test(v) ? `${k}=${v}` : `${k}="${v.replace(/"/g, "")}"`));
  return parts.length ? `{${parts.join(" ")}}` : "";
}

export function parseDirectiveOpen(text: string): { colons: number; name: string; label?: string; attrs?: Record<string, string> } | null {
  const m = /^(:{3,})[ \t]*([A-Za-z][\w-]*)[ \t]*(?:\[([^\]]*)\])?[ \t]*(?:\{([^}]*)\})?/.exec(text);
  if (!m) return null;
  const out: { colons: number; name: string; label?: string; attrs?: Record<string, string> } = { colons: m[1]!.length, name: m[2]! };
  const label = m[3]?.trim();
  if (label) out.label = label;
  const attrs = m[4] != null ? parseDirectiveAttrs(m[4]) : undefined; // #393: {key=val} attributes
  if (attrs) out.attrs = attrs;
  return out;
}

// Closing fence: only colons (>= the opening count), nothing else.
export function isDirectiveClose(text: string, minColons: number): boolean {
  const m = /^(:{3,})[ \t]*$/.exec(text);
  return !!m && m[1]!.length >= minColons;
}

// #185 / ADR-096 (Option B, stack-based): the SINGLE SOURCE OF TRUTH for `:::` directive nesting.
// lezer's `composite` is called OUTER→INNER and only knows its own opening colon count, so a loose
// close (`>=`) let an inner `::::columns` close its `:::tabs` parent early (measured: `::::tabs`
// closed at the columns' `::::`, truncating the rest). Pandoc fenced_divs / remark-directive / MyST all
// solve this with an OPEN-DIV STACK where a close pops the INNERMOST open div — colon count gates only
// the OPENING nesting convention (outer ≥ inner, for readability / round-trip), NEVER the close. This
// pure single-pass resolver implements exactly that, decoupled from lezer's composite limitation, so
// directive ranges are correct at any depth. `directiveMacroAt`/`directiveChainAt`/`parseLayoutItems`
// consume THIS (sub-task 2) so range resolution is never defined twice.
export interface ResolvedDirective {
  from: number;      // offset of the opening fence line start
  to: number;        // offset of the END of the closing fence line (or text end if unclosed)
  bodyFrom: number;  // offset of the first body line (after the opening fence's newline)
  bodyTo: number;    // offset of the closing fence line start (or `to` if unclosed)
  colons: number;
  name: string;
  label?: string;
  attrs?: Record<string, string>; // #393 / ADR-151: `{key=val}` attributes off the opening fence
  depth: number;     // nesting depth (0 = top-level)
  closed: boolean;   // false if the directive ran to EOF without a matching close fence
}

// Only-colons line (a CLOSE candidate). Distinct from an OPENING fence (colons + a name), which
// `parseDirectiveOpen` matches — the two are mutually exclusive (a close has no name).
function isBareColonLine(text: string): boolean {
  return /^:{3,}[ \t]*$/.test(text);
}

export function resolveDirectiveRanges(text: string): ResolvedDirective[] {
  const out: ResolvedDirective[] = [];
  const stack: { from: number; bodyFrom: number; colons: number; name: string; label?: string; attrs?: Record<string, string>; depth: number }[] = [];
  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const bare = isBareColonLine(line);
    if (bare && stack.length > 0) {
      // CLOSE — pop the INNERMOST open directive (Pandoc semantics; colon count does NOT gate).
      const top = stack.pop()!;
      out.push({ from: top.from, to: lineEnd, bodyFrom: top.bodyFrom, bodyTo: lineStart, colons: top.colons, name: top.name, label: top.label, attrs: top.attrs, depth: top.depth, closed: true });
    } else {
      const open = parseDirectiveOpen(line);
      if (open) stack.push({ from: lineStart, bodyFrom: Math.min(lineEnd + 1, text.length), colons: open.colons, name: open.name, label: open.label, attrs: open.attrs, depth: stack.length });
      // else: a content line (or a bare `:::` with no open directive) — ignored.
    }
    offset = lineEnd + 1; // +1 for the consumed "\n"
  }
  // Unclosed directives at EOF close at the text end (reveal-on-cursor / editing an in-progress block).
  while (stack.length > 0) {
    const top = stack.pop()!;
    out.push({ from: top.from, to: text.length, bodyFrom: top.bodyFrom, bodyTo: text.length, colons: top.colons, name: top.name, label: top.label, attrs: top.attrs, depth: top.depth, closed: false });
  }
  // Sort by start offset so callers get document order (the stack pops innermost-first).
  return out.sort((a, b) => a.from - b.from || b.to - a.to);
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
      // A directive-opening line must INTERRUPT an open paragraph, the way FencedCode does
      // (CommonMark: a block construct on the next line ends the paragraph). Without this,
      // `text\n:::table` is read as one lazy paragraph and the directive never parses → the
      // macro doesn't render and vim dd/yy operate on the literal `:::` line (#91 / #90).
      endLeaf(_cx, line) {
        return parseDirectiveOpen(line.text.slice(line.pos)) != null
      },
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
