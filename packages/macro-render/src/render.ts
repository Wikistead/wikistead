import { SafeHtml, html, joinSafe, unsafeHtml } from "./safe-html.js";
import { walkMarkdown, mdParser, type MdSink, type MdOpenRole, type MdLeafRole, type MdRoleData } from "./md-visitor.js";
import { parseFenceInfo } from "./fence-info.js";
import { renderMathHtml } from "./math.js"; // #505/ADR-191: math on the static path

// #85 / ADR-059 + ADR-085 → #384 / ADR-160: the SERVER-SIDE, DOM-FREE markdown → HTML renderer for
// published / static export — now a SINK over the ONE shared visitor (md-visitor.ts). The visitor owns
// the tree-walk (node switch, marks, tables, footnotes, directive ranges, the wks-attachment:/URL-scheme
// link judgment); this sink owns only the string primitives: role → tag/class mapping through the
// SafeHtml boundary (html`` escapes; no raw concatenation of user text is possible), macro dispatch via
// the injected registry, and the fidelity badge. Because the package is DOM-free (tsconfig lib excludes
// DOM), it can never reach for `document`/`window` — the #88 XSS guarantee is structural.
//
// Macros are injected as a REGISTRY (not imported) so this stays decoupled from the editor's DOM macro
// objects: the caller supplies each macro's DOM-free descriptor (exportFidelity + htmlRender). A macro
// whose exportFidelity is "degrade" is wrapped with a fidelity badge (ADR-059 (c)) so a reader knows the
// block was simplified for export (the interactive version lives in the app). "preserve" renders plain.

export { mdParser }; // the ONE grammar (visitor-owned); headings.ts walks the same parse

export interface MacroHtmlDescriptor {
  readonly exportFidelity: "preserve" | "degrade";
  // #85: `renderInner` recursively renders a nested Markdown body to sanitized HTML (SafeHtml). Container
  // directives (columns / tabs / details / callout) call it so a `:::tab` body's table / list / nested
  // directive renders as real HTML instead of flattened raw text. Optional — leaf macros ignore it.
  // #337 point 3: `label` is the directive's `[label]`, threaded for macros whose export needs it.
  htmlRender(body: string, renderInner?: (md: string) => SafeHtml, label?: string): SafeHtml;
}

export interface MacroHtmlRegistry {
  fence(lang: string): MacroHtmlDescriptor | undefined;
  directive(name: string): MacroHtmlDescriptor | undefined;
}

const EMPTY_REGISTRY: MacroHtmlRegistry = { fence: () => undefined, directive: () => undefined };

// #85 fidelity badge (ADR-059 (c)): wrap a DEGRADED macro's export HTML so a reader sees it was
// simplified. Preserve-fidelity macros render plain (no wrapper). The badge is static, escaped markup.
function withFidelity(name: string, fidelity: "preserve" | "degrade", body: SafeHtml, note?: (name: string) => void): SafeHtml {
  if (fidelity === "preserve") return body;
  note?.(name);
  return html`<div class="wks-export-macro wks-fidelity-degrade" data-macro="${name}" data-fidelity="degrade"><span class="wks-fidelity-badge" role="img" aria-label="simplified for export" title="Simplified for export — the interactive version is in the app">◐</span>${body}</div>`;
}

// The role → static tag map for plain containers (fixed literals — never user input — so emitting the
// brackets via unsafeHtml is audited-safe; every dynamic VALUE still rides the html`` escape).
const PLAIN_TAGS: Partial<Record<MdOpenRole, string>> = {
  h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6",
  p: "p", blockquote: "blockquote", ul: "ul", ol: "ol", li: "li",
  em: "em", strong: "strong", s: "s", mark: "mark",
  table: "table", thead: "thead", tbody: "tbody", tr: "tr", th: "th", td: "td",
};

interface Frame { role: MdOpenRole | null; prefix: SafeHtml; suffix: SafeHtml; parts: SafeHtml[]; blockContainer: boolean }

// The SafeHtml sink: a stack of frames; open computes the role's prefix/suffix, close folds the frame
// into its parent. blockGap re-creates the historical renderBlocks "\n" join byte-for-byte.
class HtmlSink implements MdSink {
  private stack: Frame[] = [{ role: null, prefix: html``, suffix: html``, parts: [], blockContainer: true }];
  // #85 / ADR-022 Part 6: the degraded blocks of THIS render, in document order — the badge marks each
  // block where it sits, the report is what lets the document also say so once, up front.
  readonly degraded: string[];
  private readonly note = (name: string) => { this.degraded.push(name) };
  // A container's body renders through its own sink (renderInner), so the collector is PASSED DOWN:
  // a degraded macro nested inside `:::columns` is badged there and counted here. Sharing the array is
  // what keeps the document's one-line summary from disagreeing with the badges the reader can see.
  constructor(private macros: MacroHtmlRegistry, degraded: string[] = []) { this.degraded = degraded }

  result(): SafeHtml { return joinSafe(this.stack[0]!.parts); }
  private top(): Frame { return this.stack[this.stack.length - 1]!; }
  private emit(s: SafeHtml): void { this.top().parts.push(s); }

  open(role: MdOpenRole, data?: MdRoleData): void {
    let prefix: SafeHtml;
    let suffix: SafeHtml;
    switch (role) {
      case "link":
        if (data?.href != null) { prefix = html`<a href="${data.href}" rel="noopener noreferrer nofollow">`; suffix = unsafeHtml("</a>"); }
        else { prefix = unsafeHtml("<span>"); suffix = unsafeHtml("</span>"); }
        break;
      case "attachmentRef": prefix = unsafeHtml('<span class="wks-attachment-ref">'); suffix = unsafeHtml("</span>"); break;
      case "footnoteSection": prefix = unsafeHtml('<section class="cm-lp-footnotes" data-testid="footnotes">'); suffix = unsafeHtml("</section>"); break;
      case "footnoteList": prefix = unsafeHtml('<ol class="cm-lp-footnotes-list">'); suffix = unsafeHtml("</ol>"); break;
      case "footnoteItem": {
        const cls = data?.unreferenced ? "cm-lp-footnote-item cm-lp-footnote-unref" : "cm-lp-footnote-item";
        prefix = data?.n != null ? html`<li class="${cls}" id="fn-${String(data.n)}">` : html`<li class="${cls}">`;
        suffix = unsafeHtml("</li>");
        break;
      }
      default: {
        const tag = PLAIN_TAGS[role]!;
        prefix = unsafeHtml(`<${tag}>`);
        suffix = unsafeHtml(`</${tag}>`);
      }
    }
    this.stack.push({ role, prefix, suffix, parts: [], blockContainer: role === "blockquote" || role === "ul" || role === "ol" || role === "li" });
  }

  close(_role: MdOpenRole): void {
    const f = this.stack.pop()!;
    this.emit(joinSafe([f.prefix, ...f.parts, f.suffix]));
  }

  text(s: string): void { this.emit(html`${s}`); }

  leaf(role: MdLeafRole, data?: MdRoleData): void {
    switch (role) {
      // #505: a static checklist. `disabled` because this surface is a document, not a control — the
      // editable checkbox lives on the editing surface; here it must simply LOOK like the checklist it is.
      // #505: the visitor already decided this run is math and which flavour; render it (MathML — a
      // printed document must carry no stylesheet or font of its own). A failed render degrades to the
      // escaped TeX, which is still readable.
      case "math": {
        const rendered = renderMathHtml(data?.tex ?? "", !!data?.display);
        this.emit(rendered ?? html`${data?.tex ?? ""}`);
        return;
      }
      case "taskMarker":
        this.emit(unsafeHtml(`<input type="checkbox" disabled${data?.checked ? " checked" : ""}>`));
        return;
      case "hr": this.emit(unsafeHtml("<hr>")); return;
      case "br": this.emit(unsafeHtml("<br>")); return;
      case "inlineCode": this.emit(html`<code>${data?.text ?? ""}</code>`); return;
      case "literalBlock": this.emit(html`<p>${data?.text ?? ""}</p>`); return;
      case "footnoteRef":
        this.emit(data?.n != null
          ? html`<sup class="cm-lp-footnote-ref" id="fnref-${String(data.n)}"><a href="#fn-${String(data.n)}">${String(data.n)}</a></sup>`
          : html`<sup class="cm-lp-footnote-ref cm-lp-footnote-undef">?</sup>`);
        return;
      case "footnoteBack": this.emit(html`<a href="#fnref-${String(data?.n ?? "")}" class="cm-lp-footnote-back">↩</a>`); return;
    }
  }

  // Historical byte parity: renderBlocks joined block siblings with "\n" at the doc root and inside
  // blockquote/lists (and before the footnote section). Only in those block containers — table internals
  // and inline content never carried separators.
  blockGap(): void { if (this.top().blockContainer) this.emit(unsafeHtml("\n")); }

  fence(args: { blockName: "FencedCode" | "CodeBlock"; info: string | null; body: string }): void {
    if (args.blockName === "FencedCode" && args.info != null) {
      const lang = args.info.trim().split(/\s+/)[0];
      const macro = lang ? this.macros.fence(lang) : undefined;
      if (macro) {
        // #422: diagram-fence align export parity (#255's `align=left|right` off the info string) —
        // the same fixed-enum → fixed-class wrapper as the editor/read surfaces (never interpolated).
        const align = parseFenceInfo(args.info).align;
        try { this.emit(alignWrap(withFidelity(lang!, macro.exportFidelity, macro.htmlRender(args.body), this.note), align)); return; }
        catch { /* a macro that throws must not break the render → fall through to plain code */ }
      }
    }
    this.emit(html`<pre><code>${args.body}</code></pre>`);
  }

  // #422: `attrs` (#393) is now consumed for `:::table{align=left|right}` export parity — the server
  // sink wraps the macro output in the SAME fixed alignment class the editor/read surfaces use
  // (.cm-lp-align-* is global CSS, #267). A FIXED enum switches between FIXED class strings — the
  // attr value is never interpolated into markup (the XSS boundary of ADR-151 §2 holds).
  directive(args: { name: string | null; label: string | null; attrs: Record<string, string> | null; body: string; walkChildren: () => void }): void {
    const macro = args.name ? this.macros.directive(args.name) : undefined;
    if (macro) {
      // #85: hand the macro a recursive renderer so a container directive's nested Markdown body renders
      // as real HTML (SafeHtml — the same allowlist boundary at every depth). #335: nested body → the
      // visitor walks it topLevel=false, so its footnotes stay literal.
      const renderInner = (md: string): SafeHtml => renderDoc(md, this.macros, false, this.degraded);
      const align = args.name === "table" ? args.attrs?.align : undefined;
      try { this.emit(alignWrap(withFidelity(args.name!, macro.exportFidelity, macro.htmlRender(args.body, renderInner, args.label ?? undefined), this.note), align)); return; }
      catch { /* fall through to the generic box */ }
    }
    // Generic fallback: the wks-directive box around the node's own (block-joined) children.
    this.stack.push({ role: null, prefix: unsafeHtml('<div class="wks-directive">'), suffix: unsafeHtml("</div>"), parts: [], blockContainer: true });
    args.walkChildren();
    const f = this.stack.pop()!;
    this.emit(joinSafe([f.prefix, ...f.parts, f.suffix]));
  }
}

// #422: the shared alignment wrapper — export parity for `:::table{align=}` and `align=` diagram
// fences. FIXED class per enum value; anything else (including a crafted attr value) is a no-op.
// #393 `center` belongs in this enum. It was left out while centre was the DEFAULT and the
// wrapper only had to express a departure from it; #393 flipped the default to left, at which point
// an explicit `align=center` stopped reaching this sink at all and the same source rendered centred
// in the editor and flush left everywhere it is read or exported.
const ALIGN_CLASS: Record<string, string> = { left: "cm-lp-align-left", right: "cm-lp-align-right", center: "cm-lp-align-center" };

function alignWrap(out: SafeHtml, align: string | undefined): SafeHtml {
  const cls = align === undefined ? undefined : ALIGN_CLASS[align];
  if (!cls) return out; // no attribute, or a crafted value that is not one of the three
  return joinSafe([unsafeHtml(`<div class="${cls}">`), out, unsafeHtml("</div>")]);
}

// Render a Markdown source string to sanitized HTML (SafeHtml). Safe by construction: every dynamic
// value is escaped through the SafeHtml boundary; macros are dispatched via the injected registry and
// degraded ones are badged. `macros` defaults to none (plain Markdown only).
export function renderMarkdownToHtml(src: string, macros: MacroHtmlRegistry = EMPTY_REGISTRY): SafeHtml {
  return renderDoc(src, macros, true);
}

// #85 / ADR-022 Part 6 + ADR-059 (5): the same render, plus the list of blocks it had to simplify.
// The per-block badge answers "why does this one look like that?" only once the reader is already
// looking at it; a document handed to someone else needs to say up front that parts of it are not the
// whole thing. `degraded` names each degraded macro in document order (duplicates kept — the count is
// the point), and is EMPTY for a page that came through whole, so the caller adds no note at all.
export function renderMarkdownToHtmlWithReport(
  src: string,
  macros: MacroHtmlRegistry = EMPTY_REGISTRY,
): { html: SafeHtml; degraded: string[] } {
  const sink = new HtmlSink(macros);
  walkMarkdown(src, sink, { topLevel: true });
  return { html: sink.result(), degraded: sink.degraded };
}

// #335 / ADR-130: footnotes resolve at the TOP LEVEL only — the visitor collects/numbers/sections when
// topLevel; a nested body (macro renderInner) walks with topLevel=false → footnotes render literally.
function renderDoc(src: string, macros: MacroHtmlRegistry, topLevel: boolean, degraded?: string[]): SafeHtml {
  const sink = new HtmlSink(macros, degraded);
  walkMarkdown(src, sink, { topLevel });
  return sink.result();
}
