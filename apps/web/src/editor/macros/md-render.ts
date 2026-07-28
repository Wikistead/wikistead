import { parseFenceInfo, safeHref, walkMarkdown, walkInlineMarkdown, type MdSink, type MdOpenRole, type MdLeafRole, type MdRoleData } from "@wikistead/macro-render"; // #267 fence align=; #384/ADR-160 the ONE tree-walk + shared URL judge
import katex from "katex"; // #505: the print portal / preview draw math too — same renderer as the editor
import { parseDirectiveOpen } from "./directive-parser";
import { findDirectiveMacro, findFenceMacro, type MacroContext, type MacroSource, type MacroTheme } from "./registry";
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

// #90 S0 (A′ shared) → #384 / ADR-160 — render a Markdown source string to a SANITIZED DOM fragment.
// The tree-walk lives in the ONE shared visitor (@wikistead/macro-render md-visitor.ts); this file is the
// DOM SINK: it maps the visitor's roles to elements (with the cm-lp-* classes/testids), dispatches macros
// to liveRender, and keeps the DOM-only extras (frontmatter chips, static mode, #215 tagging, the nesting
// depth cap) as sink behaviour. SECURITY: the XSS boundary is unchanged — DOM is built node-by-node from
// the visitor's allowlist roles; text arrives ONLY via sink.text/textContent (never innerHTML); raw HTML
// in the source reaches this sink as literal text; link hrefs are pre-judged by the shared safeHref.

// #90 (approved: nest depth 2–3): cap how deep a directive may nest a LIVE macro widget. Container
// directives (columns / tabs / callouts) recurse by calling renderMarkdownToDom on their sub-bodies,
// which would otherwise dispatch nested live widgets to ANY depth. Beyond the cap a nested directive
// renders as its plain content (the generic box / real markdown) so the structure never breaks and NO
// information is lost — only the live layout framing stops. The counter is safe as a module singleton
// because rendering is fully SYNCHRONOUS (a liveRender call recurses into renderMarkdownToDom inline).
const MAX_NESTED_DIRECTIVE_DEPTH = 2; // ≈3 visual levels incl. the top-level widget (from decorations.ts)
let nestedDirectiveDepth = 0;

// #215 / ADR-100: source-anchor tagging so a nested macro rendered inside a columns/tabs widget can be
// hit-tested back to its absolute doc range. `renderBase` is the absolute doc offset of the CURRENT
// `src` slice (null = untagged / non-nested render — the branch is inert). When set, each nested-macro
// root element is tagged `data-mac-pos = renderBase + node.from`. Safe as module singletons because
// rendering is fully SYNCHRONOUS (same justification as nestedDirectiveDepth). `pendingBaseOffset`
// bridges the ONE gap the narrow liveRender(body,{theme}) API can't cross: md-render stashes a nested
// container's body base here right before dispatching to columns/tabs, which consume it via
// takePendingBaseOffset; it is reset after each dispatch so it never leaks.
let renderBase: number | null = null;
let pendingBaseOffset: number | null = null;
export function setPendingBaseOffset(v: number | null): void { pendingBaseOffset = v; }
export function takePendingBaseOffset(): number | null { const v = pendingBaseOffset; pendingBaseOffset = null; return v; }

// ADR-177 §2 (#450): THE macro dispatch. Every surface that turns a registered macro into DOM goes
// through here — the CM widget, the fence sink and the directive sink — so "a macro that renders at top
// level renders nested" holds because it is the same code, not because three call sites were kept in
// step by hand. That drift is what "`:::children` renders top-level but not nested" was.
//
// This is the seam the macro SDK will be assembled at (ADR-177 §3, Review-gated): when a macro is handed
// more than `{theme}`, exactly one function decides what it gets. Keeping the assembly in one place is a
// pre-condition of that work, which is why the helper lands before it.
//
// The POST-processing stays at each site on purpose — the widget's host resolution, the fence's plain-card
// fallback and the directive's generic box are genuinely different jobs, and folding them together would
// trade the drift this removes for a new one.
//
// `onThrow` records an EXISTING divergence rather than papering over it: the two md-render sinks swallow a
// throwing macro and fall back to plain content, while the widget site lets it propagate. Unifying that is
// a behaviour change, so it is deliberately not made here; the parameter makes the difference visible and
// greppable instead of implicit.
export interface MacroDispatch {
  theme: MacroTheme
  /** Body base handed to columns/tabs through the take-once singleton (the one gap the narrow API can't cross). */
  baseOffset?: number | null
  /** Count this render against the nesting cap (the directive sink does; the fence sink never has). */
  countDepth?: boolean
  /** How a throwing macro is handled. 'null' = the caller falls back; 'throw' = today's widget behaviour. */
  onThrow?: "null" | "throw"
}

export function dispatchMacroRender(
  macro: { liveRender?: (body: MacroSource, ctx: MacroContext) => HTMLElement },
  body: string,
  opts: MacroDispatch,
): HTMLElement | null {
  if (!macro.liveRender) return null;
  // The sinks hold plain slices of the document; the brand is asserted at this seam, exactly where the
  // call sites asserted it before, so the cast moves rather than multiplies.
  const src = body as MacroSource;
  const usesBase = opts.baseOffset !== undefined;
  if (opts.countDepth) nestedDirectiveDepth++;
  if (usesBase) setPendingBaseOffset(opts.baseOffset ?? null);
  try {
    return macro.liveRender(src, { theme: opts.theme });
  } catch (err) {
    if (opts.onThrow === "throw") throw err;
    return null; // a macro that throws must never break the surrounding render
  } finally {
    if (usesBase) setPendingBaseOffset(null);
    if (opts.countDepth) nestedDirectiveDepth--;
  }
}

// #351STATIC (no-macro) render mode for lightweight surfaces — the title-link hover card.
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

// #381the ONE code-fence header (filename tab + lang label + copy button), shared by the CM
// surface (FenceHeaderWidget delegates here) and the static prose render below — the two read surfaces
// must never diverge structurally (the nested fence had NO copy button / lang tab at all). Icons are
// trusted constant SVGs (no user input → innerHTML is XSS-safe); title/lang go through textContent.
export const FENCE_COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
export const FENCE_CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
// #502 gear/pencil glyph for the code-settings affordance (trusted constant SVG, XSS-safe like the copy icon).
export const FENCE_SETTINGS_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
export function buildFenceHeader(args: { lang: string; title?: string; code: string; canCopy: boolean; onSettings?: () => void; settingsLabel?: string }): HTMLElement {
  const row = document.createElement("div");
  row.className = "cm-lp-code-header";
  row.contentEditable = "false";
  const tab = document.createElement("span");
  tab.className = "cm-lp-code-tab";
  if (args.title) {
    const t = document.createElement("span");
    t.className = "cm-lp-code-title";
    t.textContent = args.title; // XSS-safe: textContent, never innerHTML
    tab.appendChild(t);
  }
  if (args.lang) {
    const l = document.createElement("span");
    l.className = "cm-lp-code-lang";
    l.textContent = args.lang;
    tab.appendChild(l);
  }
  // #174 comment 948: a lang-less fence must NOT emit an EMPTY tab stub — header is just the copy button.
  if (args.title || args.lang) row.appendChild(tab);
  // #456 rev (review ①/④): the code-settings ✎ lives in the header chrome, to the LEFT of the copy
  // button — the same top-right corner group, not a separate floating tooltip. EDIT surface only (the caller
  // passes onSettings iff the settings field is registered), so guests/the render surface never get it. Being
  // in the always-rendered header means keyboard/caret users see it too (④), not only on mouse hover.
  if (args.onSettings) {
    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "cm-lp-code-settings-btn";
    gear.setAttribute("data-testid", "fence-settings-hint");
    gear.setAttribute("aria-label", args.settingsLabel ?? "Code settings");
    gear.dataset.tip = args.settingsLabel ?? "Code settings"; // #530
    gear.innerHTML = FENCE_SETTINGS_ICON;
    gear.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }); // keep selection put
    gear.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); args.onSettings!(); });
    row.appendChild(gear);
  }
  if (args.canCopy) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-lp-code-copy";
    btn.setAttribute("aria-label", "Copy code");
    btn.dataset.tip = "Copy code"; // #530
    btn.innerHTML = FENCE_COPY_ICON;
    btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard?.writeText(args.code).then(() => {
        btn.classList.add("cm-lp-code-copied");
        btn.innerHTML = FENCE_CHECK_ICON;
        setTimeout(() => { btn.classList.remove("cm-lp-code-copied"); btn.innerHTML = FENCE_COPY_ICON; }, 1400);
      }).catch(() => { /* clipboard denied (insecure ctx / permission) — no-op */ });
    });
    row.appendChild(btn);
  }
  return row;
}

function tagMacro(el: HTMLElement, relFrom: number, name: string): void {
  if (renderBase == null) return; // non-nested / untagged render → inert (byte-identical to before #215)
  el.dataset.macPos = String(renderBase + relFrom);
  el.dataset.macName = name;
}

// #335 / ADR-130 §A: true while the OUTERMOST render owns the document footnote scope. A directive body is
// rendered by a nested renderMarkdownToDom call that also sees renderBase == null (a top-level container's
// body has no base offset), so `renderBase == null` alone can't tell "document root" from "macro body at
// the root". This flag does: only the outermost render collects/numbers/sections (walkMarkdown topLevel);
// a nested body walks topLevel=false → its footnotes stay literal `?` and it never starts its own section.
let footnoteDocActive = false;

// #223 / #384: the URL-scheme XSS judgment is ONE shared function (@wikistead/macro-render url-safety),
// re-exported here so the existing consumers (paste-linkify, cell-inline-format, tests) keep their import
// path while both markdown sinks share a single scheme judge (ADR-037; one XSS judgment).
export { safeHref };


// #370the nested LIST-HOST seam. The `:::tagged`/`:::children` resolution used to be wired ONLY
// at the top-level CM widget (the listSource facet), so the same macro nested inside a details/callout/
// columns body — which re-enters this synchronous renderer — silently rendered its placeholder and never
// fetched ("works top-level, dead nested": the #278/ADR-122 two-path drift class). The host (decorations)
// now threads the SAME view-filtered ListSource through this module seam around every nested render
// entry (withListHost — save/restore like staticRender; rendering is fully synchronous), and the
// directive dispatch below resolves nested lists with the SAME lifecycle as the top level: placeholder →
// async fetch through the member-only, view-filtered route → buildLinkList swap. NO new resolution path
// exists — authz stays exactly the existing seam. Height changes are caught by the containers' shared
// ResizeObserver (the block-widget rule).
export interface ListHostSeam {
  readonly fetch: (name: "tagged" | "children", body: string) => Promise<{ id: string; title: string; depth?: number }[] | null>;
  readonly navigate: (pageId: string) => void;
  readonly emptyLabel: string;
  readonly untitledLabel: string;
}
// #450 / ADR-177 slice 3: the SAME seam shape for the other two host-mediated resolutions. Until now the
// transclude and diagram resolutions lived inside the top-level MacroWidget, so a macro nested in a layout
// container reached the DOM sink instead and rendered its placeholder forever — the "renders top-level
// only" defect the ADR names, and the shape #527 reported from a page. The host installs these around a
// render exactly as it does the list host; a sink without them still gets the placeholder, which is the
// correct answer when nobody can resolve (the macro itself never fetches — ADR-024).
export interface TranscludeHostSeam {
  readonly resolve: (refId: string) => Promise<string | null>;
  readonly deniedLabel: string;
}
export interface DiagramHostSeam {
  // Mirrors the host's diagram renderer, including its legacy shapes: a bare Blob is a success and `null`
  // is a degrade, which is what existing callers already pass around (decorations.ts DiagramRenderResult).
  readonly render: (lang: string, source: string) => Promise<Blob | { ok: true; blob: Blob } | { ok: false; reason?: string } | null>;
  readonly handles: (lang: string) => boolean;
}
let activeTranscludeHost: TranscludeHostSeam | null = null;
let activeDiagramHost: DiagramHostSeam | null = null;
export function withTranscludeHost<T>(host: TranscludeHostSeam | null, fn: () => T): T {
  const prev = activeTranscludeHost;
  activeTranscludeHost = host;
  try { return fn(); } finally { activeTranscludeHost = prev; }
}
export function withDiagramHost<T>(host: DiagramHostSeam | null, fn: () => T): T {
  const prev = activeDiagramHost;
  activeDiagramHost = host;
  try { return fn(); } finally { activeDiagramHost = prev; }
}
export const currentTranscludeHost = (): TranscludeHostSeam | null => activeTranscludeHost;
export const currentDiagramHost = (): DiagramHostSeam | null => activeDiagramHost;

let activeListHost: ListHostSeam | null = null;
export function withListHost<T>(host: ListHostSeam | null, fn: () => T): T {
  const prev = activeListHost;
  activeListHost = host;
  try { return fn(); } finally { activeListHost = prev; }
}

// The rendered list-of-pages DOM (shared by `:::tagged` and `:::children`, top-level widget AND nested
// renders — moved here from decorations.ts so both paths build the identical tree). `depth` nests
// entries as real sub-<ul>s (#370); titles via textContent (XSS-inert), navigation through the
// host seam only (the destination re-confirms view → uniform 404).
export function buildLinkList(
  items: { id: string; title: string; depth?: number }[],
  label: string | null,
  src: { navigate: (id: string) => void; untitledLabel: string },
  variant: "tagged" | "children",
): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-lp-backlinks";
  box.setAttribute("data-testid", `macro-${variant}`);
  if (label) {
    const h = document.createElement("div");
    h.className = "cm-lp-backlinks-label";
    h.textContent = label;
    box.appendChild(h);
  }
  const rootUl = document.createElement("ul");
  rootUl.className = "cm-lp-backlinks-list";
  const stack: HTMLUListElement[] = [rootUl];
  for (const it of items) {
    const depth = Math.max(0, it.depth ?? 0);
    while (stack.length - 1 > depth) stack.pop();
    while (stack.length - 1 < depth) {
      const parentLi = stack[stack.length - 1]!.lastElementChild;
      if (!(parentLi instanceof HTMLLIElement)) break; // no parent item to nest under → stay at this level
      const sub = document.createElement("ul");
      sub.className = "cm-lp-backlinks-list cm-lp-backlinks-sub";
      parentLi.appendChild(sub);
      stack.push(sub);
    }
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.className = "cm-lp-backlinks-item";
    a.setAttribute("data-testid", `macro-${variant}-item-${it.id}`);
    a.href = `/p/${it.id}`;
    a.textContent = it.title || src.untitledLabel;
    a.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); src.navigate(it.id); });
    li.appendChild(a);
    stack[stack.length - 1]!.appendChild(li);
  }
  box.appendChild(rootUl);
  return box;
}

// The DOM SINK (#384 / ADR-160): maps visitor roles to elements. `stack` tracks the open container; the
// visitor's structural guarantees (marks skipped, text inert, link hrefs pre-judged, attachment scheme
// intercepted before any anchor role) arrive here already made — this class only builds allowlisted DOM.
class DomSink implements MdSink {
  private stack: Node[];
  constructor(root: Node) { this.stack = [root]; }
  private top(): Node { return this.stack[this.stack.length - 1]!; }
  private push(el: HTMLElement): void { this.top().appendChild(el); this.stack.push(el); }

  open(role: MdOpenRole, data?: MdRoleData): void {
    switch (role) {
      case "table": {
        // #406the table sits in its own horizontal scroll box, so a wide table scrolls inside
        // itself instead of widening the prose column (which made the whole page scroll sideways).
        // Both boxes are pushed so close("table") pops the pair back off.
        const box = document.createElement("div");
        box.className = "cm-lp-table-scroll";
        this.push(box);
        const t = document.createElement("table");
        t.className = "cm-lp-md-table";
        this.push(t);
        return;
      }
      case "link": {
        const href = data?.href ?? null;
        const el = document.createElement(href ? "a" : "span");
        // #223 comment 895 (B): tag the anchor cm-lp-link so it gets the body-link colour/underline
        // inside .cm-editor surfaces (Tailwind preflight had reset a bare <a> to color:inherit).
        if (href) { (el as HTMLAnchorElement).href = href; (el as HTMLAnchorElement).rel = "noopener noreferrer nofollow"; el.className = "cm-lp-link"; }
        this.push(el);
        return;
      }
      case "attachmentRef": {
        // #273 / ADR-120 → ADR-160 §2: the visitor intercepted `wks-attachment:` BEFORE any anchor role
        // this chip is the static-surface affordance (the id resolves only inside the authenticated app).
        const chip = document.createElement("span");
        chip.className = "wks-attachment-ref";
        chip.setAttribute("data-testid", "attachment-ref");
        this.push(chip);
        return;
      }
      case "footnoteSection": {
        const s = document.createElement("section");
        s.className = "cm-lp-footnotes";
        s.setAttribute("data-testid", "footnotes");
        this.push(s);
        return;
      }
      case "footnoteList": { const ol = document.createElement("ol"); ol.className = "cm-lp-footnotes-list"; this.push(ol); return; }
      case "footnoteItem": {
        const li = document.createElement("li");
        li.className = data?.unreferenced ? "cm-lp-footnote-item cm-lp-footnote-unref" : "cm-lp-footnote-item";
        if (data?.n != null) li.id = `fn-${data.n}`;
        this.push(li);
        return;
      }
      default: this.push(document.createElement(role)); // h1..h6/p/blockquote/ul/ol/li/em/strong/s/mark/thead/tbody/tr/th/td
    }
  }

  close(role: MdOpenRole): void {
    this.stack.pop();
    if (role === "table") this.stack.pop(); // #406the table opened its scroll box too
  }

  text(s: string): void { this.top().appendChild(document.createTextNode(s)); }

  leaf(role: MdLeafRole, data?: MdRoleData): void {
    switch (role) {
      // #505 / ADR-191: the visitor decided this run is math (one delimiter rule for every surface); draw
      // it with the same KaTeX call the editor makes, so the print portal shows the formula the author
      // sees instead of raw `$x^2$`. katex.render BUILDS DOM (never innerHTML of user text) and
      // trust:false keeps \href and friends disabled — the editor's exact configuration.
      case "math": {
        const el = document.createElement(data?.display ? "div" : "span");
        el.className = data?.display ? "cm-lp-math cm-lp-math-block" : "cm-lp-math cm-lp-math-inline";
        try {
          katex.render(data?.tex ?? "", el, { displayMode: !!data?.display, throwOnError: false, trust: false, strict: "warn" });
        } catch {
          el.textContent = data?.tex ?? ""; // degrade to the TeX — readable, never a broken embed
        }
        this.top().appendChild(el);
        return;
      }
      // #505: a static checklist (the shared visitor's GFM task marker). Disabled — this renderer draws a
      // DOCUMENT (print portal, preview, public read), not a control; the editable checkbox is the
      // editing surface's job. Built as an element, never innerHTML.
      case "taskMarker": {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.disabled = true;
        box.checked = !!data?.checked;
        box.className = "cm-lp-task-checkbox";
        this.top().appendChild(box);
        return;
      }
      case "hr": this.top().appendChild(document.createElement("hr")); return;
      case "br": this.top().appendChild(document.createElement("br")); return;
      case "inlineCode": { const el = document.createElement("code"); el.textContent = data?.text ?? ""; this.top().appendChild(el); return; }
      case "literalBlock": { const p = document.createElement("p"); p.textContent = data?.text ?? ""; this.top().appendChild(p); return; }
      case "footnoteRef": {
        // #335 / ADR-130: superscript number linking to the end-section definition; undefined/nested → a
        // muted `?` with no target (never a dangling link, never the raw `[^label]`). In-document anchors
        // only → XSS-inert (textContent).
        const sup = document.createElement("sup");
        sup.className = "cm-lp-footnote-ref";
        if (data?.n != null) {
          sup.id = `fnref-${data.n}`;
          const a = document.createElement("a");
          a.href = `#fn-${data.n}`;
          a.textContent = String(data.n);
          sup.appendChild(a);
        } else {
          sup.classList.add("cm-lp-footnote-undef");
          sup.textContent = "?";
        }
        this.top().appendChild(sup);
        return;
      }
      case "footnoteBack": {
        const back = document.createElement("a"); // ↩ back to the (first) reference
        back.href = `#fnref-${data?.n}`;
        back.className = "cm-lp-footnote-back";
        back.textContent = "↩";
        this.top().appendChild(back);
        return;
      }
    }
  }

  blockGap(): void { /* DOM blocks need no separator (the SafeHtml sink maps this to its "\n" join) */ }

  fence(args: { blockName: "FencedCode" | "CodeBlock"; info: string | null; body: string; nodeFrom: number }): void {
    const into = this.top();
    const body = args.body;
    let fenceMeta: { lang: string; title?: string } = { lang: "" }; // for the plain-code header below
    if (args.blockName === "FencedCode") {
      const fence = args.info != null ? parseFenceInfo(args.info) : null; // #267: full parse for lang + align=
      const lang = fence ? fence.lang : null;
      if (fence) fenceMeta = { lang: fence.lang, title: fence.title };
      const macro = lang ? findFenceMacro(lang) : undefined;
      // #351static mode never dispatches a fence macro (mermaid/plantuml/excalidraw would mount a
      // widget / render async) — a compact chip instead of the (long) raw source keeps the card small.
      if (staticRender && macro?.liveRender) { into.appendChild(staticMacroChip(lang!)); return; }
      // ADR-085 shared macro renderer: a FENCE whose info string names a registered fence macro dispatches
      // to its liveRender — the SINGLE source of truth. Unknown lang / no liveRender / a macro that THROWS
      // → the plain card below (never break the whole render). liveRender only gets `{theme}` (ADR-024).
      if (macro?.liveRender) {
        // #450 / ADR-177 (4), design review: the DIRECTIVE branch has always counted depth; this one never
        // did, so a fence macro that renders markdown containing its own fence recursed without a floor.
        // Nothing exercises that today — no fence macro re-renders markdown — but the SDK's `renderMarkdown`
        // is exactly the handle that would, and the cap has to exist BEFORE the handle does.
        if (nestedDirectiveDepth >= MAX_NESTED_DIRECTIVE_DEPTH) {
          into.appendChild(staticMacroChip(lang!)); // same floor the directive branch takes: show, stop recursing
          return;
        }
        const el = dispatchMacroRender(macro, body, { theme: currentMacroTheme(), countDepth: true });
        if (el) {
          tagMacro(el, args.nodeFrom, lang!); // #215: tag for nested hit-test
          // #450 slice 3: a diagram the HOST renders (plantuml today) gets the same swap here as the
          // top-level widget. The macro's own liveRender returns its source card — it cannot fetch
          // (ADR-024) — so without this a nested diagram showed source while the identical block one level
          // up showed a picture. No host installed → the source card stays, which is what an unresolvable
          // diagram should look like.
          const diagramHost = activeDiagramHost;
          if (diagramHost && lang && diagramHost.handles(lang) && !staticRender) {
            void diagramHost.render(lang, body).then((res) => {
              const blob = res instanceof Blob ? res : res && "ok" in res && res.ok ? res.blob : null;
              if (!blob) return; // failure or degrade keeps the source card — never a broken embed
              const img = document.createElement("img");
              img.src = URL.createObjectURL(blob);
              img.alt = "";
              img.setAttribute("data-testid", "macro-diagram-nested");
              img.className = "cm-lp-macro-diagram";
              el.replaceChildren(img);
            });
          }
          // #267: a rendered diagram is centred by default (#255); this path has no widget wrap, so apply
          // the SAME cm-lp-align-* class (global CSS backs it outside .cm-editor).
          if (DIAGRAM_MACROS.has(lang!)) el.classList.add(`cm-lp-align-${fence!.align ?? "center"}`);
          into.appendChild(el);
          return;
        }
        // a macro that threw falls through to the plain card below (unchanged)
      }
    }
    // #381the static fence is the SAME card as the CM surface — a shared header (filename tab +
    // lang + copy button, buildFenceHeader) over the code body.
    const card = document.createElement("div");
    card.className = "cm-lp-fence-card";
    card.appendChild(buildFenceHeader({ lang: fenceMeta.lang, title: fenceMeta.title, code: body, canCopy: true }));
    const pre = document.createElement("pre"); const code = document.createElement("code");
    code.textContent = body;
    pre.appendChild(code); card.appendChild(pre); into.appendChild(card);
  }

  directive(args: { name: string | null; label: string | null; attrs: Record<string, string> | null; full: string; body: string; nodeFrom: number; resolved: boolean; walkChildren: () => void }): void {
    const into = this.top();
    const { full, body } = args;
    const nl = full.indexOf("\n");
    const parsed = args.name != null ? { name: args.name, label: args.label } : parseDirectiveOpen(nl === -1 ? full : full.slice(0, nl));
    const macro = parsed ? findDirectiveMacro(parsed.name) : undefined;
    // #90: at the nesting cap, do NOT dispatch a nested live widget / callout panel — fall through to the
    // generic box (plain content), so deeply-nested directives still show their content but stop spawning
    // recursive live layouts.
    const atDepthCap = nestedDirectiveDepth >= MAX_NESTED_DIRECTIVE_DEPTH;
    // #215 / ADR-100: absolute base of THIS directive's inner body (drop the ::: open line) — handed to a
    // nested columns/tabs liveRender (pendingBaseOffset) and to renderCalloutPanel. null when untagged.
    const nestedBodyBase = renderBase != null ? renderBase + args.nodeFrom + (nl === -1 ? full.length : nl) + 1 : null;
    // #370a NESTED `:::tagged`/`:::children` resolves through the list-host seam with the same
    // placeholder → view-filtered fetch → swap lifecycle as the top-level widget (static mode keeps the
    // compact chip below — the hover card must stay fetch-free,).
    if ((parsed?.name === "tagged" || parsed?.name === "children") && activeListHost && !staticRender) {
      const host = activeListHost;
      const listName = parsed.name as "tagged" | "children";
      const holder = document.createElement("div");
      holder.className = "cm-lp-macro cm-lp-query-placeholder";
      holder.setAttribute("data-testid", `macro-${listName}-nested`);
      into.appendChild(holder);
      void host.fetch(listName, body).then((items) => {
        holder.classList.remove("cm-lp-query-placeholder");
        holder.replaceChildren();
        if (items && items.length > 0) {
          holder.appendChild(buildLinkList(items, args.label, { navigate: host.navigate, untitledLabel: host.untitledLabel }, listName));
        } else {
          holder.style.display = "none"; // nested read render: an empty/denied list shows nothing (top-level read parity)
        }
      });
      return;
    }
    // #450 slice 3: a NESTED `:::embed-page` resolves through the transclude-host seam with the same
    // lifecycle the top-level widget has had since #108 — placeholder → host-resolved markdown (authz
    // re-checked server-side on the REFERENCED page) → swap, or the uniform denied placeholder that hides
    // whether the page exists at all. Without this the nested copy sat at its placeholder forever, which is
    // the "renders top-level only" defect. Static mode keeps the chip (a hover card must stay fetch-free).
    if (parsed?.name === "embed-page" && activeTranscludeHost && !staticRender && body.trim() !== "") {
      const host = activeTranscludeHost;
      const holder = document.createElement("div");
      holder.className = "cm-lp-macro";
      holder.setAttribute("data-testid", "macro-embed-page-nested");
      into.appendChild(holder);
      void host.resolve(body.trim()).then((content) => {
        holder.replaceChildren();
        if (content == null) {
          const ph = document.createElement("div");
          ph.className = "cm-lp-embed-page-denied";
          ph.setAttribute("data-testid", "macro-embed-page-denied");
          ph.textContent = host.deniedLabel; // uniform — denied / cycle / absent are indistinguishable
          holder.appendChild(ph);
        } else {
          appendMarkdownInto(holder, content); // sanitized DOM (no innerHTML), same as the top-level path
        }
      });
      return;
    }
    // #351static mode never dispatches a directive liveRender. Markdown-CONTENT containers
    // (columns/tabs/details) fall through to the plain-content fallback so their body still shows.
    if (staticRender && macro?.liveRender && !STATIC_PLAIN_DIRECTIVES.has(parsed!.name)) {
      into.appendChild(staticMacroChip(parsed!.name));
      return;
    }
    if (!atDepthCap && !staticRender && macro?.liveRender) {
      // baseOffset hands the body base to columns/tabs (the narrow API can't pass it); countDepth keeps
      // the nesting cap honest. A throwing macro falls through to the generic box, as before.
      const el = dispatchMacroRender(macro, body, { theme: currentMacroTheme(), baseOffset: nestedBodyBase, countDepth: true });
      if (el) {
        tagMacro(el, args.nodeFrom, parsed!.name); // #215 tag
        // #393 / ADR-151: `:::table{align=…}` block alignment on the read/nested surface. FIXED enum →
        // fixed class (never raw-concatenated — the XSS boundary). No attribute = left = no wrapper.
        // The <table> itself must not become a flex container, so the class rides a wrapper div (the
        // global .cm-lp-align-* rules are flex-based).
        //`center` was missing here for as long as centre was the default. Once #393 made left
        // the default, an explicit `align=center` reached the editor's decoration but not this sink,
        // so a centred table read as flush left in Reading, in the public reader and in every export.
        const align = parsed!.name === "table" ? args.attrs?.align : undefined;
        const alignClass = align === "left" ? "cm-lp-align-left" : align === "right" ? "cm-lp-align-right" : align === "center" ? "cm-lp-align-center" : null;
        if (alignClass) {
          const alignWrap = document.createElement("div");
          alignWrap.className = alignClass;
          alignWrap.appendChild(el);
          into.appendChild(alignWrap);
          return;
        }
        into.appendChild(el);
        return;
      }
    }
    // #170 / ADR-049 (Y): a CONTAINER directive → the shared PANEL (single source of truth with the CM
    // widget), not a generic box.
    //
    // #450 (measured): this used to require `macro.icon`, so the two containers that carry no icon
    // `:::todo` and `:::details` — fell all the way through to the generic `cm-lp-md-directive` box on
    // every surface this sink draws (the read surface and the print portal). `:::todo` lost its accent
    // box and list-checks icon, and `:::details` lost its DISCLOSURE and its `[label]` outright — the
    // summary text a reader was given simply was not in the document, the same content loss #472 fixed
    // for the callout label. Meanwhile the SafeHtml sink renders both properly, so the two sinks of
    // ADR-160's one-walk-two-sinks disagreed about the same source.
    //
    // A collapsible container becomes a real <details>: it matches what the other sink emits, keeps the
    // label, and gives the reader the same collapse the editor shows — no new CSS to drift. Everything
    // else takes the panel, whose icon and accent come from the container class's own CSS variables
    // (--cb-icon/--cb-color), so an icon-less container is styled by its class rather than skipped.
    if (!atDepthCap && macro?.containerClass) {
      nestedDirectiveDepth++;
      try {
        const el = macro.collapsible
          ? renderDisclosure(parsed?.label ?? "", body, nestedBodyBase ?? undefined)
          : renderCalloutPanel(macro.containerClass, macro.icon ?? "", parsed?.label ?? "", body, nestedBodyBase ?? undefined);
        tagMacro(el, args.nodeFrom, parsed!.name); // #215: anchor in the OUTER src coords
        into.appendChild(el);
      } finally { nestedDirectiveDepth--; }
      return;
    }
    // Generic fallback (unknown/depth-capped directive). When the resolver recognized the directive, its
    // range is authoritative — render the corrected body recursively (not the lezer node's possibly
    // truncated children) so a nested container still shows all its content; a resolver miss keeps the
    // plain child walk (#267).
    const el = document.createElement("div"); el.className = "cm-lp-md-directive";
    if (args.resolved) {
      appendMarkdownInto(el, body, nestedBodyBase ?? undefined);
    } else {
      el.classList.add("wks-prose"); // #381: the child walk emits the same raw-tag vocabulary
      this.stack.push(el);
      try { args.walkChildren(); } finally { this.stack.pop(); }
    }
    into.appendChild(el);
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
  const prevDocActive = footnoteDocActive;
  const prevStatic = staticRender;
  // #351opt-IN only — a nested re-entry (a container body render) passes no opts and must
  // INHERIT the current mode, so an inner macro can't escape static by being one level deeper.
  if (opts?.staticMacros) staticRender = true;
  renderBase = baseOffset ?? null;
  // #370 / ADR-145: a TOP-LEVEL leading frontmatter block renders as a tag-chip row, never as raw YAML.
  // Only at the document root (baseOffset == null); the source stays verbatim (Open formats), display only.
  let fmChips: HTMLElement | null = null;
  if (renderBase == null) {
    const fm = parseFrontmatterRange(src);
    if (fm) {
      fmChips = buildFrontmatterChips(parseFmTags(fm.inner));
      src = src.slice(fm.to).replace(/^\n/, "");
    }
  }
  try {
    const frag = document.createDocumentFragment();
    // #335 / ADR-130: footnote resolution is TOP-LEVEL / DOCUMENT-ROOT ONLY (walkMarkdown topLevel) — the
    // outermost render collects/numbers and appends the end-of-document section; a nested render (a macro
    // cell with a baseOffset, OR a directive body re-rendered at the root) walks topLevel=false → its
    // footnotes stay literal `?` and it never starts its own section (§A).
    const collect = renderBase == null && !footnoteDocActive;
    if (collect) footnoteDocActive = true;
    if (fmChips) frag.appendChild(fmChips); // #370: the tag-chip row heads the rendered document
    walkMarkdown(src, new DomSink(frag), { topLevel: collect });
    return frag;
  } finally { renderBase = prevBase; footnoteDocActive = prevDocActive; staticRender = prevStatic; }
}

// #89 (WYSIWYG cell, comment 830): render a ONE-LINE Markdown string's INLINE marks (bold/italic/strike/
// code/link) to a sanitized DOM fragment — via the SAME shared visitor (marks hidden, raw HTML degrades
// to escaped text, hrefs scheme-checked). No innerHTML (ADR-037 / the #89 XSS boundary is preserved).
export function renderInlineMarkdownToDom(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const rendered = walkInlineMarkdown(text, new DomSink(frag));
  if (!rendered && text) frag.appendChild(document.createTextNode(text)); // no paragraph (blank) → literal text
  return frag;
}

// #170 / ADR-049 (Y): the shared callout PANEL renderer (single source of truth). A flex 2-column
// panel — a large icon column (mask-image, currentColor-tinted, vertically centred against the whole
// panel via CSS align-items) + a main column (variant-coloured title + nested Markdown body). Used by
// the CM live widget (decorations.ts, top-level callouts) AND the nested dispatch above (callouts
// inside transclude/columns), so both render identically. Display-only; XSS-safe (title via
// textContent, body via the sanitized renderMarkdownToDom, icon via data-icon + CSS mask, no innerHTML).
// #450: a COLLAPSIBLE container (`:::details`) on a read surface — the same `<details><summary>` the
// SafeHtml sink emits, so the two sinks agree and the label reaches the reader. Native disclosure: no
// script, no stylesheet, and it survives into print and into a saved page.
export function renderDisclosure(label: string, body: string, baseOffset?: number): HTMLElement {
  const el = document.createElement("details");
  el.className = "cm-lp-details-disclosure";
  const summary = document.createElement("summary");
  summary.textContent = label.trim() || "Details"; // text, never HTML — same boundary as the panel title
  el.appendChild(summary);
  const bodyEl = document.createElement("div");
  appendMarkdownInto(bodyEl, body, baseOffset);
  el.appendChild(bodyEl);
  return el;
}

export function renderCalloutPanel(containerClass: string, icon: string, label: string, body: string, baseOffset?: number): HTMLElement {
  const wrap = document.createElement("div");
  // #453the callout takes the selection ring, so it wears the shared atom-box marker too
  // otherwise a peer's presence box measures the full content width around it (740px vs its real 692px).
  wrap.className = `${containerClass} cm-lp-callout-panel cm-lp-atom-box`;
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
