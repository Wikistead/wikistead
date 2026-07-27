import { parser, Strikethrough, Table, TaskList } from "@lezer/markdown";
import { directiveExtension, parseDirectiveOpen, resolveDirectiveRanges, type ResolvedDirective } from "./directive-parser.js";
import { highlightExtension } from "./highlight-ext.js";
import { footnoteExtension } from "./footnote-ext.js";
import { safeHref } from "./url-safety.js";
import { findMathSpans } from "./math.js"; // #505: one math-delimiter rule, both sinks
import { HEADINGS, footnoteRefLabel } from "./md-nodes.js";

// #384 / ADR-160: ONE markdown tree-walk, two sinks. This visitor owns every structural decision the
// two hand-mirrored walkers (apps/web md-render.ts DOM walk; render.ts SafeHtml walk) used to duplicate:
// the node switch, MARKS skipping, inline recursion + leading-space trim, table structure, footnote
// collection/numbering/section, the resolver-corrected directive ranges, and the wks-attachment: / URL
// scheme judgment for links. It can ONLY emit through the sink's open/close/text/leaf hooks — it never
// builds markup — so the XSS rule holds by construction: `text` is inert in both sinks (textContent /
// html-escape), and the only per-sink asymmetries (macro dispatch, DOM extras, cosmetic class maps) live
// behind the delegated `fence` / `directive` hooks (ADR-160 §1).

// #505/#207/#85 (ADR-191): TaskList joins the GFM set. Without it `- [ ] todo` reached the static
// surfaces as literal text and `- [x]` came out as a stray `<span>x</span>` — so a checklist that reads
// as checkboxes in the editor printed as mangled prose, which the print acceptance ("no rendered element
// breaks") forbids. Adding it HERE fixes both static sinks at once, which is the point of one visitor.
export const mdParser = parser.configure([directiveExtension, Strikethrough, Table, TaskList, highlightExtension, footnoteExtension]);
export type MdNode = ReturnType<typeof mdParser.parse>["topNode"];

// Container roles emitted via open/close; leaf roles via leaf().
export type MdOpenRole =
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  | "p" | "blockquote" | "ul" | "ol" | "li"
  | "em" | "strong" | "s" | "mark"
  | "table" | "thead" | "tbody" | "tr" | "th" | "td"
  | "link" | "attachmentRef"
  | "footnoteSection" | "footnoteList" | "footnoteItem";
export type MdLeafRole = "hr" | "br" | "inlineCode" | "literalBlock" | "footnoteRef" | "footnoteBack" | "taskMarker" | "math";
export interface MdRoleData {
  href?: string | null;      // link (null = scheme-rejected → non-link)
  n?: number | null;         // footnoteRef / footnoteItem / footnoteBack number
  checked?: boolean;         // taskMarker — a GFM `- [x]` item (#505)
  tex?: string;              // math — the TeX between the delimiters (#505)
  display?: boolean;         // math — $$block$$ vs $inline$ (#505)
  unreferenced?: boolean;    // footnoteItem
  text?: string;             // inlineCode / literalBlock
}

export interface MdSink {
  open(role: MdOpenRole, data?: MdRoleData): void;
  close(role: MdOpenRole): void;
  text(s: string): void; // ALWAYS inert (textContent / escaped) — the XSS rule
  leaf(role: MdLeafRole, data?: MdRoleData): void;
  // Called BETWEEN two block-level siblings (and before the footnote section): the SafeHtml sink maps it
  // to the historical "\n" join; the DOM sink no-ops. Keeps the migration byte-stable.
  blockGap(): void;
  // Sink-owned constructs the visitor delegates whole (the real asymmetries — macro dispatch etc.).
  fence(args: { blockName: "FencedCode" | "CodeBlock"; info: string | null; body: string; nodeFrom: number }): void;
  directive(args: {
    name: string | null; label: string | null; attrs: Record<string, string> | null; full: string; body: string;
    nodeFrom: number; bodyStartRel: number;
    // true when resolveDirectiveRanges recognized this directive (its range is authoritative — the DOM
    // sink re-renders the corrected body); false = resolver miss → fall back to the lezer child walk.
    resolved: boolean;
    walkChildren: () => void; // render the lezer node's children through this same sink (generic fallback)
  }): void;
}

// Mark/structural nodes whose own text must NOT be emitted.
export const MARKS = new Set([
  "EmphasisMark", "CodeMark", "LinkMark", "HeaderMark", "QuoteMark", "ListMark",
  "DirectiveMark", "URL", "CodeInfo", "LinkTitle",
  "StrikethroughMark", "HighlightMark", "FootnoteDefMark",
]);

const INLINE_WRAP: Record<string, MdOpenRole> = { Emphasis: "em", StrongEmphasis: "strong", Strikethrough: "s", Highlight: "mark" };

export const txt = (src: string, n: MdNode): string => src.slice(n.from, n.to);

// #296/#267: lezer early-closes a nested `:::` at an inner directive's close; resolveDirectiveRanges is
// the single truth for `:::` ranges. Memoised per source (bounded), shared by both sinks' callers too.
const rdCache = new Map<string, ResolvedDirective[]>();
export function resolvedFor(src: string): ResolvedDirective[] {
  let r = rdCache.get(src);
  if (!r) { r = resolveDirectiveRanges(src); if (rdCache.size > 64) rdCache.clear(); rdCache.set(src, r); }
  return r;
}
function consumedEnd(node: MdNode, src: string): number {
  if (node.name !== "Directive") return node.to;
  const rd = resolvedFor(src).find((d) => d.from === node.from);
  return rd ? rd.to : node.to;
}
export function directiveBody(full: string): string {
  const lines = full.split("\n").slice(1);
  if (lines.length && /^\s*:::+\s*$/.test(lines[lines.length - 1]!)) lines.pop();
  return lines.join("\n");
}
export function stripMarks(node: MdNode, src: string, mark: string): string {
  let out = "", pos = node.from;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === mark) { if (c.from > pos) out += src.slice(pos, c.from); pos = c.to; }
  }
  out += src.slice(pos, node.to);
  return out;
}

// #335 / ADR-130: the document-scoped footnote pass (identical on both sides before #384 — now one).
// Numbers by FIRST-REFERENCE order; duplicate def → first wins; nodes inside a resolved `:::` range are
// skipped (§A — a nested footnote renders literally where it stands and never joins the document section).
export interface FootnoteData { numbers: Map<string, number>; defs: Map<string, MdNode>; order: string[]; unreferenced: string[] }
export function collectFootnotes(tree: MdNode, src: string): FootnoteData {
  const refOrder: string[] = [];
  const defs = new Map<string, MdNode>();
  const dirs = resolvedFor(src);
  const insideMacro = (pos: number): boolean => dirs.some((d) => pos > d.from && pos < d.to);
  tree.cursor().iterate((n) => {
    if (n.name === "FootnoteRef") {
      if (insideMacro(n.from)) return;
      const label = footnoteRefLabel(src, n.from, n.to);
      if (label) refOrder.push(label);
    } else if (n.name === "FootnoteDef") {
      if (insideMacro(n.from)) return;
      const m = /^\[\^([^\]\s]+)\]:/.exec(src.slice(n.from, n.to));
      const label = m?.[1];
      if (label && !defs.has(label)) defs.set(label, n.node);
    }
  });
  const numbers = new Map<string, number>();
  const order: string[] = [];
  for (const label of refOrder) {
    if (defs.has(label) && !numbers.has(label)) { numbers.set(label, numbers.size + 1); order.push(label); }
  }
  const unreferenced = [...defs.keys()].filter((l) => !numbers.has(l));
  return { numbers, defs, order, unreferenced };
}

// One walk = one WalkState; the footnote map is LOCAL to the walk (a nested body is a separate
// walkMarkdown call with topLevel=false → map null → literal footnotes; ADR-130 §A). No module state.
interface WalkState { src: string; sink: MdSink; fnNumbers: Map<string, number> | null }

// #505 / ADR-191: prose text is where `$…$` / `$$…$$` live, so the visitor splits them out HERE and hands
// each one to the sink as a `math` leaf. Doing it in the visitor rather than in each sink is what ADR-160
// asks for — the delimiter rules (the Pandoc guards that keep prose about money from becoming math) are
// decided ONCE, so the DOM surface and the HTML export cannot drift about what math even is. Each sink
// still chooses how to draw it. Text that contains no math takes exactly the path it always did.
function emitProse(st: WalkState, s: string): void {
  const spans = findMathSpans(s);
  if (spans.length === 0) { st.sink.text(s); return }
  let at = 0;
  for (const m of spans) {
    if (m.from > at) st.sink.text(s.slice(at, m.from));
    st.sink.leaf("math", { tex: m.tex, display: m.display });
    at = m.to;
  }
  if (at < s.length) st.sink.text(s.slice(at));
}

function walkInlineChildren(st: WalkState, parent: MdNode): void {
  let pos = parent.from;
  let first = true; // trim the leading syntax space after an opening mark (e.g. "# " / "- " / "> ")
  const pushText = (s: string) => {
    const v = first ? s.replace(/^[ \t]+/, "") : s;
    if (v) { st.sink.text(v); first = false; }
  };
  // #505 / ADR-191: math spans are resolved over this node's WHOLE source, once, before the child walk —
  // the same thing the editor does over the whole document. Scanning the per-child text runs instead was
  // measurably wrong: markdown emits an `Escape` node for every backslash, so `$$\int_0^1 x\,dx$$` reached
  // the sink as four fragments and never matched, and the formula printed as raw TeX. A span found here
  // swallows whatever the parser put inside it (those Escapes are TeX, not markdown).
  const spans = findMathSpans(st.src.slice(parent.from, parent.to))
    .map((m) => ({ ...m, from: m.from + parent.from, to: m.to + parent.from }));
  const spanAt = (i: number) => spans.find((sp) => i >= sp.from && i < sp.to);
  // Emit source[pos, end) as prose, breaking out any math span it crosses.
  const flushTo = (end: number) => {
    while (pos < end) {
      const here = spanAt(pos);
      if (here) {
        if (pos === here.from) { st.sink.leaf("math", { tex: here.tex, display: here.display }); first = false; }
        pos = Math.min(here.to, end);
        continue;
      }
      const next = spans.find((sp) => sp.from > pos && sp.from < end);
      const stop = next ? next.from : end;
      pushText(st.src.slice(pos, stop));
      pos = stop;
    }
  };
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.from > pos) flushTo(c.from);
    if (spanAt(c.from)) { pos = Math.max(pos, c.to); continue } // inside math — the span owns this text
    if (!MARKS.has(c.name)) { walkInlineNode(st, c); first = false; }
    pos = c.to;
  }
  if (pos < parent.to) flushTo(parent.to);
}

function walkInlineNode(st: WalkState, node: MdNode): void {
  const wrap = INLINE_WRAP[node.name];
  if (wrap) { st.sink.open(wrap); walkInlineChildren(st, node); st.sink.close(wrap); return; }
  switch (node.name) {
    case "FootnoteRef": {
      const n = st.fnNumbers?.get(footnoteRefLabel(st.src, node.from, node.to)) ?? null;
      st.sink.leaf("footnoteRef", { n });
      return;
    }
    case "InlineCode": st.sink.leaf("inlineCode", { text: stripMarks(node, st.src, "CodeMark") }); return;
    case "Link": {
      const urlNode = node.getChild("URL");
      const rawHref = urlNode ? txt(st.src, urlNode) : "";
      // #273 / ADR-120 → ADR-160 §2: `wks-attachment:` is OUR opaque scheme; it must NEVER be emitted as
      // a raw anchor on a static surface. Under one visitor this is the SINGLE structural intercept —
      // it fires before ANY anchor role can be emitted (supersedes the "two sites" wording; both sinks'
      // anti-tests remain as the per-surface pins).
      if (/^\s*wks-attachment:/i.test(rawHref)) {
        st.sink.open("attachmentRef");
        st.sink.text("📎 ");
        walkInlineChildren(st, node);
        st.sink.close("attachmentRef");
        return;
      }
      const href = safeHref(rawHref) || null; // the ONE shared scheme judge (#384)
      st.sink.open("link", { href });
      walkInlineChildren(st, node);
      st.sink.close("link");
      return;
    }
    // #505: GFM task marker. The parser gives `[ ]` / `[x]` as its own node inside the item's paragraph;
    // both sinks turn it into a disabled checkbox, so a printed / exported checklist looks like one.
    case "TaskMarker": st.sink.leaf("taskMarker", { checked: /x/i.test(txt(st.src, node)) }); return;
    case "HardBreak": st.sink.leaf("br"); return;
    // HTML* and anything else inline → literal inert text (the XSS-safe default).
    default: emitProse(st, txt(st.src, node));
  }
}

function walkBlock(st: WalkState, node: MdNode): number | void {
  const { sink, src } = st;
  const heading = HEADINGS[node.name] as MdOpenRole | undefined;
  if (heading) { sink.open(heading); walkInlineChildren(st, node); sink.close(heading); return; }
  switch (node.name) {
    // #335: at the document root a def is collected into the end section (map set) — skip in body flow.
    // In a nested body (map null) emit it as literal text (no content loss).
    case "FootnoteDef": {
      if (st.fnNumbers == null) sink.leaf("literalBlock", { text: txt(src, node) });
      return;
    }
    case "Paragraph": sink.open("p"); walkInlineChildren(st, node); sink.close("p"); return;
    case "Blockquote": sink.open("blockquote"); walkBlockChildren(st, node); sink.close("blockquote"); return;
    case "BulletList": sink.open("ul"); walkBlockChildren(st, node); sink.close("ul"); return;
    case "OrderedList": sink.open("ol"); walkBlockChildren(st, node); sink.close("ol"); return;
    case "ListItem": sink.open("li"); walkBlockChildren(st, node); sink.close("li"); return;
    // #505: a GFM task item. The parser wraps the item body in `Task` (TaskMarker + the inline content)
    // with NO Paragraph, so without this case the whole thing fell to the block default and printed as
    // literal "[ ] todo". Walk it as INLINE so the marker becomes a checkbox and the rest stays prose.
    case "Task": walkInlineChildren(st, node); return;
    case "FencedCode": case "CodeBlock": {
      const t = node.getChild("CodeText");
      const info = node.name === "FencedCode" ? node.getChild("CodeInfo") : null;
      sink.fence({ blockName: node.name, info: info ? txt(src, info) : null, body: t ? txt(src, t) : "", nodeFrom: node.from });
      return;
    }
    case "HorizontalRule": sink.leaf("hr"); return;
    case "Table": {
      sink.open("table");
      let tbodyOpen = false;
      for (let row = node.firstChild; row; row = row.nextSibling) {
        const isHeader = row.name === "TableHeader";
        if (!isHeader && row.name !== "TableRow") continue; // skip TableDelimiter
        if (isHeader) {
          if (tbodyOpen) { sink.close("tbody"); tbodyOpen = false; }
          sink.open("thead");
        } else if (!tbodyOpen) { sink.open("tbody"); tbodyOpen = true; }
        sink.open("tr");
        for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
          if (cell.name !== "TableCell") continue;
          const role: MdOpenRole = isHeader ? "th" : "td";
          sink.open(role); walkInlineChildren(st, cell); sink.close(role);
        }
        sink.close("tr");
        if (isHeader) sink.close("thead");
      }
      if (tbodyOpen) sink.close("tbody");
      sink.close("table");
      return;
    }
    case "Directive": {
      const rd = resolvedFor(src).find((d) => d.from === node.from);
      const end = rd ? rd.to : node.to;
      const full = src.slice(node.from, end);
      const nl = full.indexOf("\n");
      const parsed = parseDirectiveOpen(nl === -1 ? full : full.slice(0, nl));
      sink.directive({
        name: parsed?.name ?? null,
        label: parsed?.label ?? null,
        attrs: parsed?.attrs ?? null, // #393 / ADR-151: `{key=val}` off the opening fence
        full,
        body: directiveBody(full),
        nodeFrom: node.from,
        bodyStartRel: nl === -1 ? full.length : nl + 1,
        resolved: !!rd,
        walkChildren: () => walkBlockChildren(st, node),
      });
      return end;
    }
    // Unknown block (incl. HTMLBlock — the #89 XSS lifeline: literal source, never a live element).
    default: sink.leaf("literalBlock", { text: txt(src, node) });
  }
}

function walkBlockChildren(st: WalkState, parent: MdNode): void {
  let skipUntil = -1; // a resolver-corrected directive range consumes the siblings lezer leaked
  let emitted = false;
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (MARKS.has(c.name)) continue;
    if (c.from < skipUntil) continue;
    if (emitted) st.sink.blockGap();
    const consumed = walkBlock(st, c);
    emitted = true;
    if (typeof consumed === "number" && consumed > skipUntil) skipUntil = consumed;
  }
}

function emitFootnoteSection(st: WalkState, fn: FootnoteData): void {
  const { sink } = st;
  sink.open("footnoteSection");
  sink.leaf("hr");
  sink.open("footnoteList");
  const item = (n: number | null, def: MdNode, unreferenced: boolean) => {
    sink.open("footnoteItem", { n, unreferenced });
    walkInlineChildren(st, def); // FootnoteDefMark is in MARKS → only the note text renders
    if (n != null) { sink.text(" "); sink.leaf("footnoteBack", { n }); }
    sink.close("footnoteItem");
  };
  for (const label of fn.order) { const def = fn.defs.get(label); if (def) item(fn.numbers.get(label)!, def, false); }
  for (const label of fn.unreferenced) item(null, fn.defs.get(label)!, true);
  sink.close("footnoteList");
  sink.close("footnoteSection");
}

// Walk `src` into `sink`. topLevel=true collects/numbers footnotes and appends the end-of-document
// section; false (a nested macro body) leaves the map null → footnotes render literally (ADR-130 §A).
export function walkMarkdown(src: string, sink: MdSink, opts: { topLevel: boolean }): void {
  const tree = mdParser.parse(src);
  const fn = opts.topLevel ? collectFootnotes(tree.topNode, src) : null;
  const st: WalkState = { src, sink, fnNumbers: fn ? fn.numbers : null };
  walkBlockChildren(st, tree.topNode);
  if (fn && (fn.order.length > 0 || fn.unreferenced.length > 0)) {
    sink.blockGap();
    emitFootnoteSection(st, fn);
  }
}

// #89 (WYSIWYG cell): walk only the FIRST paragraph's INLINE content (marks hidden), or emit the text
// literally when the source has no paragraph. Shared so both sinks' inline-only surfaces stay identical.
export function walkInlineMarkdown(text: string, sink: MdSink): boolean {
  const tree = mdParser.parse(text);
  let para: MdNode | null = null;
  for (let c = tree.topNode.firstChild; c; c = c.nextSibling) { if (c.name === "Paragraph") { para = c; break; } }
  if (!para) return false;
  walkInlineChildren({ src: text, sink, fnNumbers: null }, para);
  return true;
}
