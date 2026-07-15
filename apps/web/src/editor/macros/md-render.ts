import { parser, Strikethrough, Table } from "@lezer/markdown";
import { parseFenceInfo, highlightExtension, footnoteExtension, safeHref, HEADINGS, footnoteRefLabel } from "@wikistead/macro-render"; // #267 fence align=; #334 highlight; #335 footnote grammar; #384 shared URL judge + heading map + footnote label
import { directiveExtension, parseDirectiveOpen, resolveDirectiveRanges, type ResolvedDirective } from "./directive-parser";
import { findDirectiveMacro, findFenceMacro } from "./registry";
import { currentMacroTheme } from "./theme";
import { parseFrontmatterRange, parseFmTags, type FmTag } from "../live-preview/frontmatter";

// #267: rendered diagram fences default to CENTER (#255) and can carry an align= attribute — mirror the
// editor's set (decorations.ts) so this out-of-editor render path centers them the same way. Text macros
// (callout/table/columns) never align.
const DIAGRAM_MACROS = new Set(["mermaid", "plantuml", "excalidraw"]);

// #370 / ADR-145: the read-surface tag-chip row for a leading frontmatter block. Plain DOM + textContent
// (titles/tags are author text — no innerHTML). Empty tags → an empty row is NOT rendered (null-ish handled
// by the caller keeping a zero-child wrapper is avoided by returning a row only when there are chips).
function buildFrontmatterChips(tags: FmTag[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "cm-lp-frontmatter wks-prose-frontmatter";
  row.setAttribute("data-testid", "prose-frontmatter");
  for (const t of tags) {
    const chip = document.createElement("span");
    chip.className = "cm-lp-frontmatter-chip";
    chip.setAttribute("data-testid", `prose-fm-tag-${t.tag}`);
    chip.textContent = t.display;
    row.appendChild(chip);
  }
  if (tags.length === 0) row.style.display = "none"; // frontmatter with no tags → nothing visible, fences still hidden
  return row;
}

// #90 S0 (A′ shared) — render a Markdown source string to a SANITIZED DOM fragment, for use
// INSIDE a block-widget macro (columns / tabs) that can't reach CodeMirror's own renderers (the
// macro host is `{theme}` only). Built on the same @lezer/markdown parser the editor uses (no new
// dependency). SECURITY: this is the XSS boundary — DOM is built node-by-node from an allowlist;
// text is set via textContent (never innerHTML); raw HTML in the source is rendered as LITERAL
// TEXT (the HTML* nodes fall through to the text default), so `<script>` can never execute; link
// hrefs are scheme-checked. Anything unhandled degrades to its source text (safe).

// #89 comment 848: GFM Strikethrough (`~~x~~`) so the shared renderer emits <s> (renderInline already has the
// case; the base CommonMark parser didn't produce the node). GFM is the target format (Open formats), and the
// table-cell inline-format toolbar's strike must round-trip to a rendered <s> in the non-editing cell too.
// #174 point 4: GFM Table so a pipe table nested inside a columns/tabs/transclude widget renders as a real
// <table> instead of the raw `| a | b |` source (the shared server renderer gets the same extension). The
// Table render case below builds the DOM node-by-node (textContent only), so it stays inside the XSS
// boundary — a cell's content is inline markdown, never raw HTML.
const mdParser = parser.configure([directiveExtension, Strikethrough, Table, highlightExtension, footnoteExtension]);
// @lezer/common isn't a direct dependency — derive the SyntaxNode type from the parser instead.
type SNode = ReturnType<typeof mdParser.parse>["topNode"];

// #90 (approved: nest depth 2–3): cap how deep a directive may nest a LIVE macro widget. Container
// directives (columns / tabs / callouts) recurse by calling renderMarkdownToDom on their sub-bodies,
// which would otherwise dispatch nested live widgets to ANY depth — a runaway for recursive rendering
// and, worse while #183 (vim atom-boundary motion, symptom C) is open, for atom motion + reveal
// granularity (#196). Beyond the cap a nested directive renders as its plain content (the generic box
// / real markdown) so the structure never breaks and NO information is lost — only the live layout
// framing stops. The counter is safe as a module singleton because rendering is fully SYNCHRONOUS
// (a liveRender call recurses into renderMarkdownToDom inline; no async interleaving between renders).
const MAX_NESTED_DIRECTIVE_DEPTH = 2; // ≈3 visual levels incl. the top-level widget (from decorations.ts)
let nestedDirectiveDepth = 0;

// #215 / ADR-100: source-anchor tagging so a nested macro rendered inside a columns/tabs widget can be
// hit-tested back to its absolute doc range. `renderBase` is the absolute doc offset of the CURRENT
// `src` slice (null = untagged / non-nested render — the branch is inert). When set, each nested-macro
// root element is tagged `data-mac-pos = renderBase + node.from` (an offset guaranteed inside the macro;
// consumers RE-RESOLVE the live range from it). Safe as module singletons because rendering is fully
// SYNCHRONOUS (same justification as nestedDirectiveDepth). `pendingBaseOffset` bridges the ONE gap the
// narrow liveRender(body,{theme}) API can't cross: md-render stashes a nested container's body base here
// right before dispatching to columns/tabs, which consume it via takePendingBaseOffset; it is reset
// after each dispatch so it never leaks. MUST move together with MAX_NESTED_DIRECTIVE_DEPTH if depth changes.
let renderBase: number | null = null;
let pendingBaseOffset: number | null = null;
export function setPendingBaseOffset(v: number | null): void { pendingBaseOffset = v; }
export function takePendingBaseOffset(): number | null { const v = pendingBaseOffset; pendingBaseOffset = null; return v; }

// #351 STATIC (no-macro) render mode for lightweight surfaces — the title-link hover card.
// While active, a fence/directive macro is NEVER dispatched to liveRender: no widget/canvas/iframe is
// mounted and no host fetch can fire from inside the render (the user's ruling: the card stays light).
// A macro renders instead as a compact placeholder CHIP — except markdown-CONTENT containers
// (columns/tabs/details), whose body is worth showing and falls through to the plain-content fallback,
// and icon callouts (no liveRender), whose panel is pure display and keeps rendering. Module singleton
// like nestedDirectiveDepth (rendering is fully synchronous), so nested bodies inherit the mode.
let staticRender = false;
const STATIC_PLAIN_DIRECTIVES = new Set(["columns", "tabs", "details"]);
function staticMacroChip(label: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "cm-lp-md-macro-chip";
  chip.setAttribute("data-testid", "static-macro-chip");
  chip.textContent = `◇ ${label}`; // a label only — never the macro's resolved content
  return chip;
}

// #267: lezer's markdown grammar early-closes a nested `:::tabs` at an inner directive's close, so the
// Directive node's `to` is wrong and slicing by it truncates a multi-tab/column body. resolveDirectiveRanges
// (stack-based, Pandoc semantics) is the single truth for `:::` ranges (same fix as fence.ts for the CM
// widgets). Memoised per source string so the hot render path scans each body once. Bounded.
const rdCache = new Map<string, ResolvedDirective[]>();
function resolvedDirectivesFor(src: string): ResolvedDirective[] {
  let r = rdCache.get(src);
  if (!r) {
    r = resolveDirectiveRanges(src);
    if (rdCache.size > 64) rdCache.clear();
    rdCache.set(src, r);
  }
  return r;
}
function tagMacro(el: HTMLElement, relFrom: number, name: string): void {
  if (renderBase == null) return; // non-nested / untagged render → inert (byte-identical to before #215)
  el.dataset.macPos = String(renderBase + relFrom);
  el.dataset.macName = name;
}

// Mark/structural nodes whose own text must NOT be emitted (the `*`/`#`/`[` `]` `(` `)` etc.).
const MARKS = new Set([
  "EmphasisMark", "CodeMark", "LinkMark", "HeaderMark", "QuoteMark", "ListMark",
  "DirectiveMark", "URL", "CodeInfo", "LinkTitle",
  "StrikethroughMark", // #89 comment 848: skip the `~~` delimiters so <s> holds only the text
  "HighlightMark", // #334 / ADR-129: skip the `==` delimiters so <mark> holds only the text
  "FootnoteDefMark", // #335 / ADR-130: skip the `[^label]:` marker; the def body renders alone
]);

// #335 / ADR-130: footnote resolution is DOCUMENT-SCOPED and TOP-LEVEL only (renderBase == null). During a
// top-level render, `footnoteNumbers` maps a label → its number (first-reference order). A FootnoteRef renders
// its number as a superscript link using this map; nested renders (renderBase != null) leave it null so a
// footnote inside a macro body stays literal (ADR-130 §A). fn-<n> / fnref-<n> id namespace (ADR-130 §E).
let footnoteNumbers: Map<string, number> | null = null;
// #335 / ADR-130 §A: true while the OUTERMOST render owns the document footnote scope. A directive body is
// rendered by a nested renderMarkdownToDom call that also sees renderBase == null (a top-level container's
// body has no base offset), so `renderBase == null` alone can't tell "document root" from "macro body at the
// root". This flag does: only the outermost render collects/numbers/sections; a nested body leaves the map
// null → its footnotes stay literal `?` and it never starts its own section (matches the server's renderDoc).
let footnoteDocActive = false;
// The label inside `[^label]` (a FootnoteRef node spans `[^` … `]`).
// #384: HEADINGS (node→tag map) and footnoteRefLabel are shared from @wikistead/macro-render (imported above),
// so the DOM and SafeHtml sinks read the same markdown-grammar judgments. Block-level nodes get their own
// recursion; everything else is inline/text.

// Block dangerous schemes; allow everything else (relative, https, mailto, …). Never throws.
// The blocklist POLICY is unchanged; this normalizes the URL the way a browser does BEFORE checking,
// so the check can't be evaded and legit URLs aren't mangled
// 1. Strip a surrounding <…> (CommonMark angle-bracket destinations arrive WITH the brackets from
// the parser). Without this a legit `<https://x>` renders as the broken relative href `<https://x>`,
// and a `<javascript:…>` only failed to fire by accident (the literal `<` made it a relative URL).
// 2. Remove the control chars a browser IGNORES inside a URL before evaluating the scheme
// (TAB/LF/CR/NUL + other C0/DEL) — otherwise `java⇥script:` would slip past the blocklist yet
// execute once the browser drops the tab. Matching the browser's normalization closes that.
// #223 / #384: the URL-scheme XSS judgment is ONE shared function now (@wikistead/macro-render url-safety),
// imported above and re-exported here so the existing consumers (paste-linkify, cell-inline-format, tests) keep
// their import path while both markdown sinks share a single scheme judge (ADR-037; one XSS judgment).
export { safeHref };

const txt = (src: string, n: SNode) => src.slice(n.from, n.to);

// Render the children of `parent` over [from,to): emit a text node for each gap, recurse into
// inline child nodes, and SKIP mark nodes (so `**x**` becomes <strong>x</strong>, not `**x**`).
function renderInline(parent: SNode, src: string, into: Node): void {
  let pos = parent.from;
  let first = true; // trim the leading syntax space after an opening mark (e.g. "# " / "- " / "> ")
  const pushText = (s: string) => {
    const v = first ? s.replace(/^[ \t]+/, "") : s;
    if (v) { into.appendChild(document.createTextNode(v)); first = false; }
  };
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.from > pos) pushText(src.slice(pos, c.from));
    if (!MARKS.has(c.name)) { renderInlineNode(c, src, into); first = false; }
    pos = c.to;
  }
  if (pos < parent.to) pushText(src.slice(pos, parent.to));
}

function renderInlineNode(node: SNode, src: string, into: Node): void {
  switch (node.name) {
    case "Emphasis": { const el = document.createElement("em"); renderInline(node, src, el); into.appendChild(el); return; }
    case "StrongEmphasis": { const el = document.createElement("strong"); renderInline(node, src, el); into.appendChild(el); return; }
    case "Strikethrough": { const el = document.createElement("s"); renderInline(node, src, el); into.appendChild(el); return; }
    case "Highlight": { const el = document.createElement("mark"); renderInline(node, src, el); into.appendChild(el); return; } // #334 / ADR-129
    // #335 / ADR-130: a footnote REFERENCE → a superscript number linking to its end-section definition. The
    // number comes from the document-scoped map (first-reference order). An undefined reference (no matching
    // def, or a nested/non-top-level render where the map is null) renders as a muted number with no target
    // never a dangling link, never the raw `[^label]`. In-document anchors only → XSS-inert (textContent).
    case "FootnoteRef": {
      const label = footnoteRefLabel(src, node.from, node.to);
      const n = footnoteNumbers?.get(label);
      const sup = document.createElement("sup");
      sup.className = "cm-lp-footnote-ref";
      if (n != null) {
        sup.id = `fnref-${n}`;
        const a = document.createElement("a");
        a.href = `#fn-${n}`;
        a.textContent = String(n);
        sup.appendChild(a);
      } else {
        sup.classList.add("cm-lp-footnote-undef");
        sup.textContent = "?"; // referenced-but-undefined (or a nested render) — muted, no target
      }
      into.appendChild(sup);
      return;
    }
    case "InlineCode": { const el = document.createElement("code"); el.textContent = stripMarks(node, src, "CodeMark"); into.appendChild(el); return; }
    case "Link": {
      const urlNode = node.getChild("URL");
      const rawHref = urlNode ? txt(src, urlNode) : "";
      // #273 / ADR-120: intercept OUR `wks-attachment:` scheme — never emit it as a raw anchor.
      // This renderer serves macro cells and the PUBLIC reader (renderMarkdownToDom), which can't
      // resolve the id, so the affordance is a plain non-link chip (review condition ①: one of the
      // TWO intercept sites — packages/macro-render render.ts is the other; keep both).
      if (/^\s*wks-attachment:/i.test(rawHref)) {
        const chip = document.createElement("span");
        chip.className = "wks-attachment-ref";
        chip.setAttribute("data-testid", "attachment-ref");
        chip.appendChild(document.createTextNode("📎 "));
        renderInline(node, src, chip);
        into.appendChild(chip);
        return;
      }
      const href = safeHref(rawHref) || null;
      const el = document.createElement(href ? "a" : "span");
      // #223 comment 895 (B): tag the anchor cm-lp-link so it gets the same colour + underline the body
      // decoration links have. This shared renderer draws links in the static TableWidget, the RichUI grid,
      // and the in-cell edit island — all inside .cm-editor, where the baseTheme .cm-lp-link rule applies
      // so a cell link now LOOKS like a link (Tailwind preflight had reset a bare <a> to color:inherit).
      if (href) { (el as HTMLAnchorElement).href = href; (el as HTMLAnchorElement).rel = "noopener noreferrer nofollow"; el.className = "cm-lp-link"; }
      renderInline(node, src, el); // link text (marks + URL skipped)
      into.appendChild(el);
      return;
    }
    case "HardBreak": into.appendChild(document.createElement("br")); return;
    // HTML*, and anything else inline → literal text (the XSS-safe default).
    default: into.appendChild(document.createTextNode(txt(src, node)));
  }
}

// The text of `node` minus a given mark (e.g. InlineCode without its backticks).
function stripMarks(node: SNode, src: string, mark: string): string {
  let out = "", pos = node.from;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === mark) { if (c.from > pos) out += src.slice(pos, c.from); pos = c.to; }
  }
  out += src.slice(pos, node.to);
  return out;
}

// Returns the absolute end offset it CONSUMED when it rendered a `:::` directive whose lezer range was
// corrected/extended by the resolver (#267), so the caller skips the sibling nodes lezer leaked past the
// early-close; void for every other block.
function renderBlock(node: SNode, src: string, into: Node): number | void {
  if (HEADINGS[node.name]) { const el = document.createElement(HEADINGS[node.name]!); renderInline(node, src, el); into.appendChild(el); return; }
  switch (node.name) {
    // #335 / ADR-130: at the document root a footnote DEFINITION is collected into the end-of-document section
    // (footnoteNumbers set) — skip it in the body flow. Inside a macro body (§A, footnoteNumbers null) there is
    // no collection, so render it as LITERAL text rather than dropping it (no content loss).
    case "FootnoteDef": {
      if (footnoteNumbers == null) { const p = document.createElement("p"); p.textContent = txt(src, node); into.appendChild(p); }
      return;
    }
    case "Paragraph": { const el = document.createElement("p"); renderInline(node, src, el); into.appendChild(el); return; }
    case "Blockquote": { const el = document.createElement("blockquote"); renderBlocks(node, src, el); into.appendChild(el); return; }
    case "BulletList": { const el = document.createElement("ul"); renderBlocks(node, src, el); into.appendChild(el); return; }
    case "OrderedList": { const el = document.createElement("ol"); renderBlocks(node, src, el); into.appendChild(el); return; }
    case "ListItem": { const el = document.createElement("li"); renderBlocks(node, src, el); into.appendChild(el); return; }
    case "FencedCode": case "CodeBlock": {
      const t = node.getChild("CodeText");
      const body = t ? txt(src, t) : "";
      // ADR-085 shared macro renderer: a FENCE whose info string names a registered fence macro
      // (```mermaid / ```excalidraw …) dispatches to its liveRender — the SINGLE source of truth
      // so a diagram fence INSIDE a transclude / column / tab renders as the real macro, not a raw
      // <pre><code> (completes the client dispatch for BOTH macro shapes: directive above, fence here).
      // Only FencedCode carries an info string (indented CodeBlock never does). Unknown lang / no
      // liveRender / a macro that THROWS → the plain <pre><code> below (never break the whole render).
      // liveRender only gets `{theme}` (ADR-024 narrow host-API) — display-only.
      if (node.name === "FencedCode") {
        const info = node.getChild("CodeInfo");
        const fence = info ? parseFenceInfo(txt(src, info)) : null; // #267: full parse for lang + align=
        const lang = fence ? fence.lang : null;
        const macro = lang ? findFenceMacro(lang) : undefined;
        // #351 static mode never dispatches a fence macro (mermaid/plantuml/excalidraw would mount a
        // widget / render async) — a compact chip instead of the (long) raw source keeps the card small.
        if (staticRender && macro?.liveRender) { into.appendChild(staticMacroChip(lang!)); return; }
        if (macro?.liveRender) {
          try {
            const el = macro.liveRender(body, { theme: currentMacroTheme() });
            tagMacro(el, node.from, lang!); // #215: tag for nested hit-test
            // #267: a rendered diagram is centred by default (#255). The editor centres via the widget's
            // cm-lp-align-* wrap; this render path (preview/public/nested) has no wrap, so the diagram sat
            // left. Apply the SAME class here (global CSS backs .cm-lp-align-* outside .cm-editor).
            if (DIAGRAM_MACROS.has(lang!)) el.classList.add(`cm-lp-align-${fence!.align ?? "center"}`);
            into.appendChild(el);
            return;
          }
          catch { /* a macro that throws must not break the render → fall through to plain code */ }
        }
      }
      const pre = document.createElement("pre"); const code = document.createElement("code");
      code.textContent = body;
      pre.appendChild(code); into.appendChild(pre); return;
    }
    case "HorizontalRule": into.appendChild(document.createElement("hr")); return;
    case "Table": {
      // #174 point 4: GFM pipe table → a real <table>. TableHeader row → <th>s in a <thead>; each TableRow
      // → <td>s in a <tbody>; TableDelimiter (the `|---|` separator) is skipped. Cell content is inline
      // markdown rendered via renderInline (textContent only — no innerHTML — so it's XSS-safe).
      const table = document.createElement("table");
      table.className = "cm-lp-md-table";
      let tbody: HTMLElement | null = null;
      for (let row = node.firstChild; row; row = row.nextSibling) {
        const isHeader = row.name === "TableHeader";
        if (!isHeader && row.name !== "TableRow") continue; // skip TableDelimiter
        const tr = document.createElement("tr");
        for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
          if (cell.name !== "TableCell") continue;
          const td = document.createElement(isHeader ? "th" : "td");
          renderInline(cell, src, td);
          tr.appendChild(td);
        }
        if (isHeader) { const thead = document.createElement("thead"); thead.appendChild(tr); table.appendChild(thead); }
        else { if (!tbody) { tbody = document.createElement("tbody"); table.appendChild(tbody); } tbody.appendChild(tr); }
      }
      into.appendChild(table);
      return;
    }
    case "Directive": {
      // ADR-085 shared macro renderer: dispatch a nested directive to its registered macro's
      // liveRender (the SINGLE source of truth) so a `:::callout`/`:::columns` etc. INSIDE a
      // transclude / column / tab renders as the real macro — not a generic box (#108, nested #90).
      // Container macros call renderMarkdownToDom on their sub-bodies, so nesting recurses here to any
      // depth. Unknown name / no liveRender / a macro that THROWS → the safe generic box (never break
      // the whole render). liveRender only gets `{theme}` (ADR-024 narrow host-API) — display-only.
      // #267: use the resolver's corrected end (lezer early-closes nested :::tabs). `dirTo` also becomes this
      // block's consumed range so renderBlocks skips the sibling nodes lezer leaked past the early-close.
      const rd = resolvedDirectivesFor(src).find((d) => d.from === node.from);
      const dirTo = rd ? rd.to : node.to;
      const full = src.slice(node.from, dirTo);
      const nl = full.indexOf("\n");
      const parsed = parseDirectiveOpen(nl === -1 ? full : full.slice(0, nl));
      const macro = parsed ? findDirectiveMacro(parsed.name) : undefined;
      // #90: at the nesting cap, do NOT dispatch a nested live widget / callout panel — fall through
      // to the generic box below (renderBlocks → plain content), so deeply-nested directives still
      // show their content but stop spawning recursive live layouts.
      const atDepthCap = nestedDirectiveDepth >= MAX_NESTED_DIRECTIVE_DEPTH;
      // #215 / ADR-100: absolute base of THIS directive's inner body (drop the ::: open line) — handed to
      // a nested columns/tabs liveRender (pendingBaseOffset) and to renderCalloutPanel so their nested
      // macros tag themselves. null when the surrounding render is untagged (non-nested).
      const nestedBodyBase = renderBase != null ? renderBase + node.from + (nl === -1 ? full.length : nl) + 1 : null;
      // #351 static mode never dispatches a directive liveRender. Fetch-backed macros (embed-page /
      // embed-external / transclude / query / backlinks) and other widget macros render as a compact chip;
      // markdown-CONTENT containers (columns/tabs/details) fall through to the plain-content fallback below
      // so their body still shows (light, no widget). Icon callouts have no liveRender and keep their
      // pure-display panel; its body recursion inherits the static flag (module singleton).
      if (staticRender && macro?.liveRender && !STATIC_PLAIN_DIRECTIVES.has(parsed!.name)) {
        into.appendChild(staticMacroChip(parsed!.name));
        return dirTo;
      }
      if (!atDepthCap && !staticRender && macro?.liveRender) {
        const lines = full.split("\n").slice(1); // drop the opening ::: line
        if (lines.length && /^\s*:::+\s*$/.test(lines[lines.length - 1]!)) lines.pop(); // drop close :::
        nestedDirectiveDepth++;
        setPendingBaseOffset(nestedBodyBase); // hand the body base to columns/tabs (narrow API can't pass it)
        let el: HTMLElement | null = null;
        try { el = macro.liveRender(lines.join("\n"), { theme: currentMacroTheme() }); }
        catch { /* a macro that throws must not break the render → fall through to the generic box */ }
        finally { setPendingBaseOffset(null); nestedDirectiveDepth--; }
        if (el) { tagMacro(el, node.from, parsed!.name); into.appendChild(el); return dirTo; } // #215: tag for nested hit-test
      }
      // #170 / ADR-049 (Y): a CONTAINER directive with an icon = a typed callout. It has no
      // liveRender (its body stays Markdown), so render the shared callout PANEL (icon + title +
      // nested body) — the single source of truth reused by the CM widget (decorations.ts) and here
      // (nested callouts inside transclude/columns render as real panels, not a generic box).
      if (!atDepthCap && macro?.containerClass && macro.icon) {
        const lines = full.split("\n").slice(1);
        if (lines.length && /^\s*:::+\s*$/.test(lines[lines.length - 1]!)) lines.pop();
        nestedDirectiveDepth++;
        try {
          const panel = renderCalloutPanel(macro.containerClass, macro.icon, parsed?.label ?? "", lines.join("\n"), nestedBodyBase ?? undefined);
          tagMacro(panel, node.from, parsed!.name); // #215: tag for nested hit-test (anchor in the OUTER src coords)
          into.appendChild(panel);
        } finally { nestedDirectiveDepth--; }
        return dirTo;
      }
      // Generic fallback (unknown/depth-capped directive). When the resolver corrected the range, render the
      // CORRECTED body recursively (not the lezer node's truncated children) so a nested container still shows
      // all its content; otherwise keep the plain node walk. #267.
      const el = document.createElement("div"); el.className = "cm-lp-md-directive";
      if (rd) {
        const bodyLines = full.split("\n").slice(1);
        if (bodyLines.length && /^\s*:::+\s*$/.test(bodyLines[bodyLines.length - 1]!)) bodyLines.pop();
        appendMarkdownInto(el, bodyLines.join("\n"), nestedBodyBase ?? undefined);
      } else {
        el.classList.add("wks-prose"); // #381: renderBlocks emits the same raw-tag vocabulary
        renderBlocks(node, src, el);
      }
      into.appendChild(el); return dirTo;
    }
    // Unknown block (incl. HTMLBlock) → literal text, safe.
    default: { const p = document.createElement("p"); p.textContent = txt(src, node); into.appendChild(p); }
  }
}

// Render the BLOCK children of a container (skipping marks); leaf inline content under a block
// without block children is handled by renderBlock's inline path.
function renderBlocks(parent: SNode, src: string, into: Node): void {
  let skipUntil = -1; // #267: a corrected `:::` directive range consumes the sibling nodes lezer leaked
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (MARKS.has(c.name)) continue;
    if (c.from < skipUntil) continue;
    const consumed = renderBlock(c, src, into);
    if (typeof consumed === "number" && consumed > skipUntil) skipUntil = consumed;
  }
}

// #381 / ADR-163: THE way to put rendered markdown into a container. Adds `.wks-prose` (the single
// raw-tag prose stylesheet, styles/prose.css) to the container and appends the sanitized fragment
// appending through this helper is what makes a future surface unable to forget the prose class (the
// #335/#351 parity-gap class). NEVER call this on `.cm-content` / non-markdown DOM (ADR-163 invariant).
export function appendMarkdownInto(el: HTMLElement, src: string, baseOffset?: number, opts?: { staticMacros?: boolean }): void {
  el.classList.add("wks-prose");
  el.appendChild(renderMarkdownToDom(src, baseOffset, opts));
}

// Parse `src` as Markdown and return a sanitized DOM fragment. Safe by construction (no innerHTML).
// #215 / ADR-100: `baseOffset` (optional) is the absolute doc offset of `src`; when set, nested macros
// are tagged `data-mac-pos` for the columns/tabs hit-test. Omitted (all existing callers) → byte-identical
// output. renderBase is saved/restored so nested renderMarkdownToDom calls don't corrupt a parent's base.
export function renderMarkdownToDom(src: string, baseOffset?: number, opts?: { staticMacros?: boolean }): DocumentFragment {
  const prevBase = renderBase;
  const prevFn = footnoteNumbers;
  const prevDocActive = footnoteDocActive;
  const prevStatic = staticRender;
  // #351 opt-IN only — a nested re-entry (a container body render) passes no opts and must
  // INHERIT the current mode, so an inner macro can't escape static by being one level deeper.
  if (opts?.staticMacros) staticRender = true;
  renderBase = baseOffset ?? null;
  // #370 / ADR-145: a TOP-LEVEL leading frontmatter block renders as a tag-chip row, never as raw YAML
  // (a `---` fence would otherwise render as a thematic break + stray text). Only at the document root
  // (baseOffset == null — a nested macro-cell render keeps its text literal); the source stays verbatim
  // in the markdown (Open formats), this is display only.
  let fmChips: HTMLElement | null = null;
  if (renderBase == null) {
    const fm = parseFrontmatterRange(src);
    if (fm) {
      fmChips = buildFrontmatterChips(parseFmTags(fm.inner));
      src = src.slice(fm.to).replace(/^\n/, "");
    }
  }
  try {
    const tree = mdParser.parse(src);
    const frag = document.createDocumentFragment();
    // #335 / ADR-130: footnote resolution is TOP-LEVEL / DOCUMENT-ROOT ONLY. The outermost render (renderBase
    // == null AND not already inside a footnote document) collects the ref order (→ numbers) and definitions,
    // renders the body (refs use the number map, defs are skipped), then appends the end-of-document section. A
    // nested render (a macro cell with a baseOffset, OR a directive body re-rendered at the root) leaves
    // footnoteNumbers null → its footnotes stay literal `?` and it never starts its own section (§A).
    const collect = renderBase == null && !footnoteDocActive;
    const fn = collect ? collectFootnotes(tree.topNode, src) : null;
    footnoteNumbers = fn ? fn.numbers : null;
    if (collect) footnoteDocActive = true;
    if (fmChips) frag.appendChild(fmChips); // #370: the tag-chip row heads the rendered document
    renderBlocks(tree.topNode, src, frag);
    if (fn && (fn.order.length > 0 || fn.unreferenced.length > 0)) frag.appendChild(renderFootnoteSection(fn, src));
    return frag;
  } finally { renderBase = prevBase; footnoteNumbers = prevFn; footnoteDocActive = prevDocActive; staticRender = prevStatic; }
}

// #335 / ADR-130: the document-scoped footnote pass. Numbers are assigned by FIRST-REFERENCE order; a repeated
// reference shares its number. Definitions are matched by label; a duplicate definition — the FIRST wins.
// `order` = referenced labels in number order; `unreferenced` = defined-but-never-referenced (still shown,
// de-emphasised, so content is never silently dropped).
interface FootnoteData { numbers: Map<string, number>; defs: Map<string, SNode>; order: string[]; unreferenced: string[]; }
function collectFootnotes(tree: SNode, src: string): FootnoteData {
  // Pass 1: gather every reference label in document order (defs can appear after refs) and every definition.
  const refOrder: string[] = [];
  const defs = new Map<string, SNode>();
  // #335 / ADR-130 §A: a footnote inside a `:::` macro/callout body renders LITERALLY there (a muted `?`) and
  // must NOT be pulled into the document-end section — otherwise this reader and the server export diverge
  // (ADR-085) and the nested ref/def would collide with a top-level number. The lezer tree nests those nodes
  // under the Directive, so skip any node strictly inside a resolved directive range (nested directives are
  // covered: an inner-body node lies inside every enclosing range).
  const dirs = resolvedDirectivesFor(src);
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
      if (label && !defs.has(label)) defs.set(label, n.node); // duplicate def → first wins
    }
  });
  // Pass 2: number ONLY references that have a matching definition, by first-reference order (a repeated
  // reference shares its number). A reference with no def gets no number → it renders as a muted `?` (§D).
  const numbers = new Map<string, number>();
  const order: string[] = [];
  for (const label of refOrder) {
    if (defs.has(label) && !numbers.has(label)) { numbers.set(label, numbers.size + 1); order.push(label); }
  }
  const unreferenced = [...defs.keys()].filter((l) => !numbers.has(l));
  return { numbers, defs, order, unreferenced };
}

// Render the collected definitions' inline body (everything after the `[^label]:` mark). Reuses renderInline;
// the FootnoteDefMark is in MARKS so it is skipped, leaving just the note text (XSS-inert, textContent path).
function renderFootnoteBody(def: SNode, src: string, into: Node): void { renderInline(def, src, into); }

function renderFootnoteSection(fn: FootnoteData, src: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "cm-lp-footnotes";
  section.setAttribute("data-testid", "footnotes");
  const hr = document.createElement("hr");
  section.appendChild(hr);
  const ol = document.createElement("ol");
  ol.className = "cm-lp-footnotes-list";
  // Referenced defs first (in number order), then unreferenced (de-emphasised). A referenced label with no
  // definition contributes NO list item (the ref already renders as a muted `?`); content is never dropped.
  for (const label of fn.order) {
    const def = fn.defs.get(label);
    if (!def) continue;
    ol.appendChild(footnoteItem(fn.numbers.get(label)!, def, src, false));
  }
  for (const label of fn.unreferenced) {
    ol.appendChild(footnoteItem(null, fn.defs.get(label)!, src, true));
  }
  section.appendChild(ol);
  return section;
}

function footnoteItem(n: number | null, def: SNode, src: string, unreferenced: boolean): HTMLElement {
  const li = document.createElement("li");
  li.className = unreferenced ? "cm-lp-footnote-item cm-lp-footnote-unref" : "cm-lp-footnote-item";
  if (n != null) li.id = `fn-${n}`;
  renderFootnoteBody(def, src, li);
  if (n != null) {
    li.appendChild(document.createTextNode(" "));
    const back = document.createElement("a"); // ↩ back to the (first) reference
    back.href = `#fnref-${n}`;
    back.className = "cm-lp-footnote-back";
    back.textContent = "↩";
    li.appendChild(back);
  }
  return li;
}

// #89 (WYSIWYG cell, comment 830): render a ONE-LINE Markdown string's INLINE marks (bold/italic/strike/
// code/link) to a sanitized DOM fragment — em/strong/s/code/a via the SAME allowlist-by-construction
// renderInline the shared renderer uses (raw HTML degrades to escaped text; hrefs are scheme-checked). The
// table-cell WYSIWYG surface uses this to SHOW `**a**` as bold "a" (marks hidden) while the source stays
// Markdown, without ever writing innerHTML (ADR-037 / the #89 XSS boundary is preserved).
export function renderInlineMarkdownToDom(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const tree = mdParser.parse(text);
  let para: SNode | null = null;
  for (let c = tree.topNode.firstChild; c; c = c.nextSibling) { if (c.name === "Paragraph") { para = c; break; } }
  if (para) renderInline(para, text, frag);
  else if (text) frag.appendChild(document.createTextNode(text)); // no paragraph (blank) → literal text
  return frag;
}

// #170 / ADR-049 (Y): the shared callout PANEL renderer (single source of truth). A flex 2-column
// panel — a large icon column (mask-image, currentColor-tinted, vertically centred against the whole
// panel via CSS align-items) + a main column (variant-coloured title + nested Markdown body). Used by
// the CM live widget (decorations.ts, top-level callouts) AND the nested dispatch above (callouts
// inside transclude/columns), so both render identically. Display-only; XSS-safe (title via
// textContent, body via the sanitized renderMarkdownToDom, icon via data-icon + CSS mask, no innerHTML).
export function renderCalloutPanel(containerClass: string, icon: string, label: string, body: string, baseOffset?: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `${containerClass} cm-lp-callout-panel`;
  wrap.setAttribute("data-testid", "callout-panel");
  const ic = document.createElement("span");
  ic.className = "cm-lp-callout-panel-icon";
  ic.setAttribute("data-icon", icon);
  wrap.appendChild(ic);
  const main = document.createElement("div");
  main.className = "cm-lp-callout-panel-main";
  if (label) {
    const title = document.createElement("div");
    title.className = "cm-lp-callout-panel-title";
    title.setAttribute("data-label", label);
    title.textContent = label; // XSS-safe: text, never HTML
    main.appendChild(title);
  }
  const bodyEl = document.createElement("div");
  bodyEl.className = "cm-lp-callout-panel-body";
  appendMarkdownInto(bodyEl, body, baseOffset); // sanitized DOM (no innerHTML); #215: thread base for nested tags
  main.appendChild(bodyEl);
  wrap.appendChild(main);
  return wrap;
}
