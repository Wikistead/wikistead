import { parser, Strikethrough, Table } from "@lezer/markdown";
import { directiveExtension, parseDirectiveOpen, resolveDirectiveRanges, type ResolvedDirective } from "./directive-parser.js";
import { SafeHtml, html, joinSafe, unsafeHtml } from "./safe-html.js";

// #85 / ADR-059 + ADR-085: the SERVER-SIDE, DOM-FREE markdown → HTML renderer for published / static
// export. It is the string counterpart of the editor's DOM renderer (apps/web md-render.ts): the SAME
// @lezer/markdown grammar (+ directive extension) and the SAME macro contract (exportFidelity +
// htmlRender → SafeHtml), so client and server are a single source of truth (ADR-085). Because it lives
// in a DOM-free package (tsconfig lib excludes DOM), it can never reach for `document`/`window` — it
// emits HTML strings only, and every dynamic value goes through the SafeHtml boundary (html`` escapes;
// no raw concatenation of user text is possible), so the export path keeps the #88 XSS guarantee.
//
// Macros are injected as a REGISTRY (not imported) so this stays decoupled from the editor's DOM macro
// objects: the caller supplies each macro's DOM-free descriptor (exportFidelity + htmlRender). A macro
// whose exportFidelity is "degrade" is wrapped with a fidelity badge (ADR-059 (c)) so a reader knows the
// block was simplified for export (the interactive version lives in the app). "preserve" renders plain.

export interface MacroHtmlDescriptor {
  readonly exportFidelity: "preserve" | "degrade";
  // #85: `renderInner` recursively renders a nested Markdown body to sanitized HTML (SafeHtml). Container
  // directives (columns / tabs / details / callout) call it so a `:::tab` body's table / list / nested
  // directive renders as real HTML instead of flattened raw text. Optional — leaf macros (table = trusted
  // HTML, mermaid = <pre>, embed = URL) ignore it and stay byte-for-byte as before.
  htmlRender(body: string, renderInner?: (md: string) => SafeHtml): SafeHtml;
}

export interface MacroHtmlRegistry {
  // A fenced-code macro keyed by its info-string language (```mermaid → "mermaid").
  fence(lang: string): MacroHtmlDescriptor | undefined;
  // A container/block directive macro keyed by its name (:::columns → "columns").
  directive(name: string): MacroHtmlDescriptor | undefined;
}

const EMPTY_REGISTRY: MacroHtmlRegistry = { fence: () => undefined, directive: () => undefined };

// #89 comment 848: GFM Strikethrough so the SERVER renderer emits <s> for `~~x~~` too — client (apps/web
// md-render) and server must stay a single source of truth (ADR-085), so a strikethrough table cell renders
// identically in the editor and on the published page. The Strikethrough case already exists below.
// #174 point 4: GFM Table so a pipe table (incl. one nested in columns/tabs/transclude) renders as a real
// <table> here too — the client md-render gets the same extension, keeping the single source of truth
// (ADR-085). Cell content goes through the `html` tag (escaped), so this stays inside the XSS boundary.
const mdParser = parser.configure([directiveExtension, Strikethrough, Table]);
type SNode = ReturnType<typeof mdParser.parse>["topNode"];

// Mark/structural nodes whose own text must NOT be emitted.
const MARKS = new Set([
  "EmphasisMark", "CodeMark", "LinkMark", "HeaderMark", "QuoteMark", "ListMark",
  "DirectiveMark", "URL", "CodeInfo", "LinkTitle",
  "StrikethroughMark", // #89 comment 848: skip the `~~` delimiters so <s> holds only the text
]);

const HEADINGS: Record<string, string> = {
  ATXHeading1: "h1", ATXHeading2: "h2", ATXHeading3: "h3", ATXHeading4: "h4", ATXHeading5: "h5", ATXHeading6: "h6",
  SetextHeading1: "h1", SetextHeading2: "h2",
};

// C0 controls (U+0000–U+001F) + DEL (U+007F): the chars a browser IGNORES inside a URL. Built from code
// points so no literal control bytes live in this source file. Matches apps/web md-render.ts safeHref.
const URL_CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`, "g");

// Block dangerous schemes; allow everything else. Mirrors apps/web md-render.ts safeHref (same policy):
// strips a surrounding <…>, removes the control chars a browser ignores inside a URL, then blocklists.
function safeHref(url: string): string | null {
  let u = url.trim();
  if (u.length >= 2 && u.startsWith("<") && u.endsWith(">")) u = u.slice(1, -1);
  u = u.replace(URL_CONTROL_CHARS, "");
  if (/^\s*(javascript|data|vbscript|file):/i.test(u)) return null;
  const trimmed = u.trim();
  return trimmed || null;
}

const txt = (src: string, n: SNode): string => src.slice(n.from, n.to);

// #85 fidelity badge (ADR-059 (c)): wrap a DEGRADED macro's export HTML so a reader sees it was
// simplified. Preserve-fidelity macros render plain (no wrapper). The badge is static, escaped markup.
function withFidelity(name: string, fidelity: "preserve" | "degrade", body: SafeHtml): SafeHtml {
  if (fidelity === "preserve") return body;
  return html`<div class="wks-export-macro wks-fidelity-degrade" data-macro="${name}" data-fidelity="degrade"><span class="wks-fidelity-badge" role="img" aria-label="simplified for export" title="Simplified for export — the interactive version is in the app">◐</span>${body}</div>`;
}

function renderInline(parent: SNode, src: string): SafeHtml {
  const parts: SafeHtml[] = [];
  let pos = parent.from;
  let first = true; // trim the leading syntax space after an opening mark (# / - / >)
  const pushText = (s: string) => {
    const v = first ? s.replace(/^[ \t]+/, "") : s;
    if (v) { parts.push(html`${v}`); first = false; }
  };
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.from > pos) pushText(src.slice(pos, c.from));
    if (!MARKS.has(c.name)) { parts.push(renderInlineNode(c, src)); first = false; }
    pos = c.to;
  }
  if (pos < parent.to) pushText(src.slice(pos, parent.to));
  return joinSafe(parts);
}

function renderInlineNode(node: SNode, src: string): SafeHtml {
  switch (node.name) {
    case "Emphasis": return html`<em>${renderInline(node, src)}</em>`;
    case "StrongEmphasis": return html`<strong>${renderInline(node, src)}</strong>`;
    case "Strikethrough": return html`<s>${renderInline(node, src)}</s>`;
    case "InlineCode": return html`<code>${stripMarks(node, src, "CodeMark")}</code>`;
    case "Link": {
      const urlNode = node.getChild("URL");
      const rawHref = urlNode ? txt(src, urlNode) : "";
      // #273 / ADR-120: `wks-attachment:` is OUR opaque scheme (a stable attachment id, resolvable
      // only through the authenticated app). It must NEVER be emitted as a raw anchor on a static
      // surface (public / print / HTML export can't resolve it), so this renderer intercepts it and
      // emits a plain non-link affordance (review condition ①: one of the TWO intercept sites —
      // apps/web md-render.ts is the other; keep both, they are separate implementations).
      if (/^\s*wks-attachment:/i.test(rawHref)) {
        return html`<span class="wks-attachment-ref">📎 ${renderInline(node, src)}</span>`;
      }
      const href = safeHref(rawHref);
      const inner = renderInline(node, src);
      return href
        ? html`<a href="${href}" rel="noopener noreferrer nofollow">${inner}</a>`
        : html`<span>${inner}</span>`;
    }
    case "HardBreak": return unsafeHtml("<br>");
    // HTML* and anything else inline → literal escaped text (the XSS-safe default).
    default: return html`${txt(src, node)}`;
  }
}

function stripMarks(node: SNode, src: string, mark: string): string {
  let out = "", pos = node.from;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === mark) { if (c.from > pos) out += src.slice(pos, c.from); pos = c.to; }
  }
  out += src.slice(pos, node.to);
  return out;
}

// The inner body of a directive: drop the opening line and the closing ::: line.
// #296: lezer's markdown grammar early-closes a nested `:::tabs` at an inner directive's close, so the
// Directive node's `to` truncates a multi-tab body and the leaked close leaks a literal `:::`.
// resolveDirectiveRanges (Pandoc-stack single truth, same fix as the editor's fence.ts / md-render.ts) gives
// the corrected end. Memoised per source string (bounded).
const rdCache = new Map<string, ResolvedDirective[]>();
function resolvedFor(src: string): ResolvedDirective[] {
  let r = rdCache.get(src);
  if (!r) { r = resolveDirectiveRanges(src); if (rdCache.size > 64) rdCache.clear(); rdCache.set(src, r); }
  return r;
}
// The absolute end offset a block CONSUMES: the resolver-corrected end for a `:::` directive, else node.to.
function consumedEnd(node: SNode, src: string): number {
  if (node.name !== "Directive") return node.to;
  const rd = resolvedFor(src).find((d) => d.from === node.from);
  return rd ? rd.to : node.to;
}

function directiveBody(full: string): string {
  const lines = full.split("\n").slice(1);
  if (lines.length && /^\s*:::+\s*$/.test(lines[lines.length - 1]!)) lines.pop();
  return lines.join("\n");
}

// An allowlisted block tag around escaped inner content. `tag` comes ONLY from fixed allowlists
// (HEADINGS, or literals below) — never user input — so wrapping it via unsafeHtml is audited-safe.
function wrapTag(tag: string, inner: SafeHtml): SafeHtml {
  return joinSafe([unsafeHtml(`<${tag}>`), inner, unsafeHtml(`</${tag}>`)]);
}

function renderBlock(node: SNode, src: string, macros: MacroHtmlRegistry): SafeHtml {
  const heading = HEADINGS[node.name];
  if (heading) return wrapTag(heading, renderInline(node, src));
  switch (node.name) {
    case "Paragraph": return html`<p>${renderInline(node, src)}</p>`;
    case "Blockquote": return html`<blockquote>${renderBlocks(node, src, macros)}</blockquote>`;
    case "BulletList": return html`<ul>${renderBlocks(node, src, macros)}</ul>`;
    case "OrderedList": return html`<ol>${renderBlocks(node, src, macros)}</ol>`;
    case "ListItem": return html`<li>${renderBlocks(node, src, macros)}</li>`;
    case "FencedCode": case "CodeBlock": {
      const t = node.getChild("CodeText");
      const body = t ? txt(src, t) : "";
      if (node.name === "FencedCode") {
        const info = node.getChild("CodeInfo");
        const lang = info ? txt(src, info).trim().split(/\s+/)[0] : null;
        const macro = lang ? macros.fence(lang) : undefined;
        if (macro) {
          try { return withFidelity(lang!, macro.exportFidelity, macro.htmlRender(body)); }
          catch { /* a macro that throws must not break the render → fall through to plain code */ }
        }
      }
      return html`<pre><code>${body}</code></pre>`;
    }
    case "HorizontalRule": return unsafeHtml("<hr>");
    case "Table": {
      // #174 point 4: GFM pipe table → a real <table>. TableHeader → <th>s in <thead>; each TableRow →
      // <td>s in <tbody>; TableDelimiter (the `|---|` separator) is skipped. Cell content is inline markdown
      // through the `html` tag (every value escaped) — the same XSS-safe boundary as every other case.
      let head: SafeHtml | null = null;
      const bodyRows: SafeHtml[] = [];
      for (let row = node.firstChild; row; row = row.nextSibling) {
        const isHeader = row.name === "TableHeader";
        if (!isHeader && row.name !== "TableRow") continue;
        const cells: SafeHtml[] = [];
        for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
          if (cell.name !== "TableCell") continue;
          cells.push(isHeader ? html`<th>${renderInline(cell, src)}</th>` : html`<td>${renderInline(cell, src)}</td>`);
        }
        const tr = html`<tr>${joinSafe(cells)}</tr>`;
        if (isHeader) head = html`<thead>${tr}</thead>`;
        else bodyRows.push(tr);
      }
      const body = bodyRows.length ? html`<tbody>${joinSafe(bodyRows)}</tbody>` : html``;
      return html`<table>${head ?? html``}${body}</table>`;
    }
    case "Directive": {
      // #296: slice with the resolver-corrected end (lezer early-closes a nested :::tabs), so a multi-item
      // body reaches the macro whole. renderBlocks skips the sibling nodes lezer leaked past the early-close.
      const full = src.slice(node.from, consumedEnd(node, src));
      const nl = full.indexOf("\n");
      const parsed = parseDirectiveOpen(nl === -1 ? full : full.slice(0, nl));
      const macro = parsed ? macros.directive(parsed.name) : undefined;
      if (macro) {
        // #85: hand the macro a recursive renderer so a container directive's nested Markdown body renders as
        // real HTML (SafeHtml, so XSS-safe by construction — the same allowlist boundary at every depth).
        const renderInner = (md: string): SafeHtml => renderMarkdownToHtml(md, macros);
        try { return withFidelity(parsed!.name, macro.exportFidelity, macro.htmlRender(directiveBody(full), renderInner)); }
        catch { /* fall through to the generic box */ }
      }
      return html`<div class="wks-directive">${renderBlocks(node, src, macros)}</div>`;
    }
    // #89 comment 782 (XSS lifeline): raw HTML (a lezer HTMLBlock — e.g. a hand-written <iframe>/<script>
    // in a `:::table` block cell) is emitted as the node's LITERAL SOURCE via `txt`, which the `html`
    // tag escapes — NOT recursed into (no child passthrough) and NEVER as a live element. Explicit here
    // (not only in `default`) so this allowlist-by-construction guarantee is unmissable at the boundary.
    case "HTMLBlock": return html`<p>${txt(src, node)}</p>`;
    // Any other un-enumerated block also degrades to literal escaped text (positive allowlist: only the
    // cases above emit real tags; everything else is escaped).
    default: return html`<p>${txt(src, node)}</p>`;
  }
}

function renderBlocks(parent: SNode, src: string, macros: MacroHtmlRegistry): SafeHtml {
  const parts: SafeHtml[] = [];
  let skipUntil = -1; // #296: a resolver-corrected directive range consumes the sibling nodes lezer leaked
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (MARKS.has(c.name)) continue;
    if (c.from < skipUntil) continue;
    parts.push(renderBlock(c, src, macros));
    const end = consumedEnd(c, src);
    if (end > skipUntil) skipUntil = end;
  }
  return joinSafe(parts, "\n");
}

// Render a Markdown source string to sanitized HTML (SafeHtml). Safe by construction: every dynamic
// value is escaped through the SafeHtml boundary; macros are dispatched via the injected registry and
// degraded ones are badged. `macros` defaults to none (plain Markdown only).
export function renderMarkdownToHtml(src: string, macros: MacroHtmlRegistry = EMPTY_REGISTRY): SafeHtml {
  const tree = mdParser.parse(src);
  return renderBlocks(tree.topNode, src, macros);
}
