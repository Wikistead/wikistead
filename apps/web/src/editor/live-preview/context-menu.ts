import { EditorView, showTooltip, type Tooltip, type TooltipView } from "@codemirror/view";
import { StateField, StateEffect, EditorSelection, Facet, Prec, type EditorState, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import i18n from "../../i18n";
import { INLINE_FORMATS } from "./commands";
import { linkifyPaste, linkCopyRange } from "./paste-linkify";
import { diagramFenceAt, setDiagramAlign, imageAlignAt, setImageAlign, tableDirectiveAt, setTableAlign } from "./decorations"; // #255: right-click diagram/image alignment; #393: table block alignment
import { tableBlockAt } from "../macros/fence";
import { toggleFenceSettings } from "./fence-settings-panel"; // #456 S4: the declared code-fence settings // #393 pipe tables get the same align entries
import type { FenceAlign } from "@wikistead/macro-render";

// M0-4 (ADR-018): the right-click context menu — the superset entry for mouse users.
// On a selection it offers layer-A decoration (the SAME INLINE_FORMATS as the bubble /
// `\` / `/` palettes) PLUS clipboard + edit-link + clear-format; on a link it offers
// edit-link; with no selection it offers paste + "Insert…" (→ the `/` palette). It is an
// EDITABLE-surface feature only: read-only / view surfaces keep the native menu (the menu
// edits the doc, which view users cannot). Built on the CM tooltip layer (NOT a node in
// view.dom — CM reconciles those away, #8), anchored at the clicked document position.
// Purely an entry point: every action dispatches normal transactions on the canonical
// Y.Text (offset-invariant, presence-safe) — same commands, another door.

type MenuKind = "selection" | "link" | "plain";
interface LinkRange { from: number; to: number; urlFrom: number; urlTo: number }
// #325 / ADR-137 slice 2b: the block-reference target for a "Copy block reference" entry — the line-end
// offset to append the marker at, plus any id already present on that line (so a repeat copy is idempotent).
interface BlockRef { lineTo: number; existingId: string | null }
interface MenuState { pos: number; kind: MenuKind; link?: LinkRange; diagramFrom?: number; imageFrom?: number; tableFrom?: number; blockRef?: BlockRef; codeFenceFrom?: number } // #456 S4: codeFenceFrom = a plain code fence at the click // #393: tableFrom = a :::table block at the click

// #325 / ADR-137 slice 2b: the current page's id, provided by the mount (member surface only). Absent on
// guest / template-preview surfaces — the block-reference entry is then hidden (a ref needs a `pageId#^id`).
const selfPageIdFacet = Facet.define<string | undefined, string | undefined>({ combine: (v) => v[0] });

const openMenu = StateEffect.define<MenuState>();
const closeMenu = StateEffect.define<null>();

const menuField = StateField.define<MenuState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(openMenu)) return e.value;
      if (e.is(closeMenu)) return null;
    }
    // A document edit dismisses the menu (its anchor would be stale). We do NOT close on
    // selection changes: the right-click's own mouseup/selection would self-close it.
    // Dismissal is via the explicit closeMenu effect (item actions), outside-click, Esc.
    if (value && tr.docChanged) return null;
    return value;
  },
  provide: (f) =>
    showTooltip.computeN([f], (state) => {
      const v = state.field(f);
      return v ? [menuTooltip(v)] : [];
    }),
});

// Find the markdown Link node enclosing `pos` (and its URL child), or null. Used to offer
// "Edit link" and to decide whether a no-selection right-click overrides the native menu.
function linkAt(state: EditorState, pos: number): LinkRange | null {
  const tree = syntaxTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 0);
  while (node && node.name !== "Link") node = node.parent;
  if (!node) return null;
  let urlFrom = node.from;
  let urlTo = node.to;
  const cur = node.cursor();
  if (cur.firstChild()) {
    do {
      if (cur.name === "URL") { urlFrom = cur.from; urlTo = cur.to; }
    } while (cur.nextSibling());
  }
  return { from: node.from, to: node.to, urlFrom, urlTo };
}

function close(view: EditorView): void {
  view.dispatch({ effects: closeMenu.of(null) });
  view.focus();
}

// ── Item actions ─────────────────────────────────────────────────────────────
function selectedText(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return view.state.doc.sliceString(from, to);
}
// #223 comment 946: the custom context menu (this file) bypasses the browser paste/copy events, so the
// pasteLinkify capture handler never sees a right-click paste, and a right-click copy over a rendered
// `[hoge](url)` link writes the raw doc slice (the `hoge](` fragment). Route both through the SAME pure
// helpers (linkifyPaste / linkCopyRange) the native paste path uses — no new XSS judge (safeHref stays the
// only one). Write text/html via ClipboardItem (createElement `<a>`, never innerHTML) so a copied link
// round-trips as a rich link.
async function writeClipboard(plain: string, html?: string): Promise<void> {
  try {
    if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      })]);
      return;
    }
    await navigator.clipboard?.writeText(plain);
  } catch { /* clipboard unavailable / denied — best effort */ }
}
function doCopy(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  if (from !== to) {
    const copy = linkCopyRange(view.state, from, to); // expand across whole links → complete source (not a fragment)
    void writeClipboard(copy?.plain ?? view.state.doc.sliceString(from, to), copy?.html);
  }
  close(view);
}
function doCut(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  if (from !== to) {
    const copy = linkCopyRange(view.state, from, to);
    void writeClipboard(copy?.plain ?? view.state.doc.sliceString(from, to), copy?.html);
    // Cut removes the (possibly link-expanded) range so the copied source matches what was removed.
    const cutFrom = copy?.from ?? from, cutTo = copy?.to ?? to;
    view.dispatch({ changes: { from: cutFrom, to: cutTo, insert: "" }, selection: EditorSelection.cursor(cutFrom) });
  }
  view.dispatch({ effects: closeMenu.of(null) });
  view.focus();
}
function doPaste(view: EditorView): void {
  close(view);
  // Read BOTH text/html and text/plain (clipboard.read) so a rich link normalizes to `[text](href)`,
  // matching the native paste path. Fall back to readText (plain) if read()/permission is unavailable.
  void (async () => {
    let text = "", html = "";
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        if (it.types.includes("text/plain")) text = await (await it.getType("text/plain")).text();
        if (it.types.includes("text/html")) html = await (await it.getType("text/html")).text();
      }
    } catch {
      try { text = await navigator.clipboard.readText(); } catch { /* clipboard denied */ }
    }
    const sel = view.state.selection.main;
    const md = linkifyPaste({ text, html, selectedText: view.state.sliceDoc(sel.from, sel.to) });
    const insert = md ?? text;
    if (insert) view.dispatch(view.state.replaceSelection(insert), { scrollIntoView: true });
    view.focus();
  })();
}
// Clear inline formatting from the selection: strip the common emphasis markers. A simple
// strip (not an AST unwrap) — adequate for the bubble's layer-A set; leaves text intact.
function doClearFormat(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const text = view.state.doc.sliceString(from, to);
  const cleaned = text.replace(/\*\*|__|~~|[*_`]/g, "");
  view.dispatch({ changes: { from, to, insert: cleaned }, selection: EditorSelection.range(from, from + cleaned.length) });
  view.focus();
}
// Edit link: select the URL inside (...) so the user types the replacement. Selecting puts
// the caret on the link line, revealing the raw `[text](url)` for editing (live-preview).
function doEditLink(view: EditorView, link: LinkRange): void {
  view.dispatch({ selection: EditorSelection.range(link.urlFrom, link.urlTo), scrollIntoView: true });
  view.focus();
  view.dispatch({ effects: closeMenu.of(null) });
}
// "Insert…": open the `/` insert palette by typing a `/` at the caret (the palette detects
// it). Works at a line start / after whitespace — the usual no-selection right-click spot.
function doInsert(view: EditorView): void {
  view.dispatch({ effects: closeMenu.of(null) });
  view.dispatch(view.state.replaceSelection("/"));
  view.focus();
}

// #325 / ADR-137 slice 2b — "Copy block reference". A block reference is a trailing ` ^<id>` marker
// (id: [a-z0-9-]{3,24}) on a block's line — ordinary text in the single Y.Text (Open formats; it round-trips).
// The affordance targets the CLICKED LINE: a paragraph / list item / heading / blockquote line resolves to
// exactly that block via sliceBlockByAnchor (a list item → the item, not the whole list). It is OUT OF SCOPE
// for atom blocks (fenced code / table / `:::` macro): a marker cannot live cleanly inside them, so the entry
// is hidden when the caret is inside one (the block-ref grammar stays a text-block feature). The clipboard gets
// `pageId#^id` — the exact string an `:::embed-page` body takes to transclude just that block.
const BLOCK_REF_LINE_RE = /[ \t]\^([a-z0-9-]{3,24})$/; // an existing ` ^<id>` already at this line's end
const ATOM_ANCESTORS = new Set(["FencedCode", "CodeBlock", "CodeText", "Table", "HTMLBlock"]); // no in-atom markers

// The block-ref target for a right-click at `pos`, or null when unavailable (no page id → no ref possible;
// a blank line → nothing to reference; inside an atom → out of scope). Pure (reads state only).
function blockRefTarget(state: EditorState, pos: number, selfPageId: string | undefined): BlockRef | null {
  if (!selfPageId) return null;
  const line = state.doc.lineAt(pos);
  if (line.text.trim() === "") return null;
  // Reject atoms: walk the resolved node's ancestors for a fenced-code / table / HTML block.
  for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 0); n; n = n.parent)
    if (ATOM_ANCESTORS.has(n.name)) return null;
  const m = BLOCK_REF_LINE_RE.exec(line.text);
  return { lineTo: line.to, existingId: m ? m[1]! : null };
}

// A short block id: 6 chars of [a-z0-9] (satisfies the [a-z0-9-]{3,24} grammar). Regenerated on the rare
// clash with an id already in the doc (sliceBlockByAnchor resolves the FIRST match, so ids must be unique).
function genBlockId(doc: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 20; attempt++) {
    let id = "";
    for (let i = 0; i < 6; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!new RegExp(`[ \\t]\\^${id}(?![\\w-])`).test(doc)) return id;
  }
  return `b${Date.now().toString(36)}`.slice(0, 24); // deterministic fallback (astronomically unlikely)
}

// Ensure the target line carries a ` ^<id>` marker (append one in a SINGLE offset-invariant edit if absent —
// the insert is at the line END so no live caret/offset before it moves), then copy `pageId#^id` to the
// clipboard. Idempotent: a line that already has a marker reuses its id (no duplicate append).
function doCopyBlockRef(view: EditorView, target: BlockRef, selfPageId: string): void {
  let id = target.existingId;
  if (!id) {
    id = genBlockId(view.state.doc.toString());
    view.dispatch({ changes: { from: target.lineTo, insert: ` ^${id}` } });
  }
  const ref = `${selfPageId}#^${id}`;
  void navigator.clipboard?.writeText(ref).catch(() => { /* clipboard unavailable / denied — best effort */ });
  close(view);
}

function menuTooltip(v: MenuState): Tooltip {
  return {
    pos: v.pos,
    above: false,
    strictSide: false,
    arrow: false,
    create: (view): TooltipView => {
      const dom = document.createElement("div");
      dom.className = "lp-context-menu";
      dom.setAttribute("data-testid", "context-menu");
      const item = (id: string, label: string, run: () => void) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "lp-context-item";
        b.textContent = label;
        b.setAttribute("data-testid", `ctx-item-${id}`);
        b.addEventListener("mousedown", (e) => { e.preventDefault(); run(); });
        dom.appendChild(b);
      };
      const sep = () => {
        const s = document.createElement("div");
        s.className = "lp-context-sep";
        dom.appendChild(s);
      };

      if (v.kind === "selection") {
        for (const f of INLINE_FORMATS) item(f.id, i18n.t(f.labelKey), () => { f.run(view); close(view); });
        sep();
        item("copy", i18n.t("contextMenu.copy"), () => doCopy(view));
        item("cut", i18n.t("contextMenu.cut"), () => doCut(view));
        item("paste", i18n.t("contextMenu.paste"), () => doPaste(view));
        if (v.link) { sep(); item("editlink", i18n.t("contextMenu.editLink"), () => doEditLink(view, v.link!)); }
        sep();
        item("clearformat", i18n.t("contextMenu.clearFormat"), () => doClearFormat(view));
      } else if (v.kind === "link" && v.link) {
        item("editlink", i18n.t("contextMenu.editLink"), () => doEditLink(view, v.link!));
        item("paste", i18n.t("contextMenu.paste"), () => doPaste(view));
      } else {
        item("paste", i18n.t("contextMenu.paste"), () => doPaste(view));
        item("insert", i18n.t("contextMenu.insert"), () => doInsert(view));
        // #325 / ADR-137 slice 2b: copy a `pageId#^id` reference to the block under the cursor (member
        // surface with a page id, text block only — see blockRefTarget). Appends the ` ^id` marker if absent.
        if (v.blockRef) {
          const selfPageId = view.state.facet(selfPageIdFacet);
          if (selfPageId) { sep(); item("copyblockref", i18n.t("contextMenu.copyBlockRef"), () => doCopyBlockRef(view, v.blockRef!, selfPageId)); }
        }
      }

      // #456 S4: a code fence's settings panel — the macro declares the controls, the host renders them
      // in the tooltip layer (fence-settings-panel.ts).
      if (v.codeFenceFrom != null && v.diagramFrom == null) {
        sep();
        item("codesettings", i18n.t("contextMenu.codeSettings"), () => { toggleFenceSettings(view, v.codeFenceFrom!); close(view); });
      }

      // #255: a rendered diagram fence adds alignment entries (left / center / right). Robust right-click
      // path (the ✎-adjacent hover button is the convenience). Rewrites the fence `align=` attribute.
      if (v.diagramFrom != null) {
        sep();
        for (const a of ["left", "center", "right"] as FenceAlign[]) {
          // #255/#243: pass the RESOLVED fence `from` (v.diagramFrom), not the raw click pos — a center-click
          // on a tall diagram lands on the block's END boundary, which setDiagramAlign's re-resolve would
          // miss (the same boundary problem the diagramFrom fallback above solves). diagramFrom is the fence's
          // opening position, so the re-resolve always lands on the node.
          item(`align-${a}`, i18n.t(`contextMenu.align${a[0]!.toUpperCase()}${a.slice(1)}`), () => { setDiagramAlign(view, v.diagramFrom!, a); close(view); });
        }
      }
      // #393 / ADR-151 (+): a table at the click → the SAME alignment entries (writes/drops the
      // directive's {align=…} attribute; LEFT is the default and attribute-less). Offered for GFM pipe
      // tables too — they are left by definition, and picking centre/right promotes them to
      // `:::table{align=…}`, which is the only place the attribute can live. Fixed enum →
      // setTableAlign (XSS: the value is never free text).
      if (v.tableFrom != null) {
        sep();
        for (const a of ["left", "center", "right"] as FenceAlign[]) {
          item(`align-${a}`, i18n.t(`contextMenu.align${a[0]!.toUpperCase()}${a.slice(1)}`), () => { setTableAlign(view, v.tableFrom!, a); close(view); });
        }
      }
      // #255 comment 1073: a standalone image at the click → the SAME alignment entries (writes ?align=).
      if (v.imageFrom != null) {
        sep();
        for (const a of ["left", "center", "right"] as FenceAlign[]) {
          item(`align-${a}`, i18n.t(`contextMenu.align${a[0]!.toUpperCase()}${a.slice(1)}`), () => { setImageAlign(view, v.imageFrom!, a); close(view); });
        }
      }

      // Outside-click dismissal via a document listener (the menu lives in the fixed
      // tooltip layer, so editor-level handlers don't see clicks elsewhere on the page).
      // Deferred a tick so the opening right-click's own mouseup/down doesn't close it.
      const onDocMouseDown = (ev: MouseEvent) => {
        if (!dom.contains(ev.target as Node)) view.dispatch({ effects: closeMenu.of(null) });
      };
      const t = window.setTimeout(() => document.addEventListener("mousedown", onDocMouseDown), 0);
      return { dom, destroy() { window.clearTimeout(t); document.removeEventListener("mousedown", onDocMouseDown); } };
    },
  };
}

// Opens the menu on right-click in the EDITABLE surface (read-only keeps native). Esc
// closes it. Highest precedence so we preventDefault the native menu before anything else.
const menuEvents = Prec.highest(
  EditorView.domEventHandlers({
    // Keep the current selection/caret when right-clicking (the browser would otherwise
    // collapse a selection / move the caret on mousedown, before contextmenu fires) so the
    // menu reflects what the user has selected. Editable surface only.
    mousedown(e, view) {
      if (e.button === 2 && !view.state.readOnly) { e.preventDefault(); return true; }
      return false;
    },
    contextmenu(e, view) {
      if (view.state.readOnly) return false; // view / read-only → native browser menu
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const sel = view.state.selection.main;
      let kind: MenuKind;
      let link: LinkRange | undefined;
      if (!sel.empty) {
        kind = "selection";
        link = linkAt(view.state, sel.from) ?? linkAt(view.state, pos) ?? undefined;
      } else {
        const l = linkAt(view.state, pos);
        if (l) { kind = "link"; link = l; } else { kind = "plain"; }
      }
      // #255: a rendered diagram fence (mermaid/plantuml/excalidraw) at the click → offer alignment.
      // #255/#243: posAtCoords on a TALL block widget can land on the block's END boundary (a center-click
      // on a top-anchored diagram), where syntaxTree resolves to the PARENT and macroFenceAt misses the
      // fence. Fall back to the clicked widget element's own doc position (posAtDOM → its `from`), which
      // always lands inside the fence. (Before #243 the widget mousedown moved the caret into the fence,
      // masking this; #243 stopped moving the caret on right-click so the widget stays rendered.)
      // #393 / ADR-151 addendum 3 §3: a `:::table`/diagram widget resolves a boundary right-click through
      // `posAtDOM(wrapEl)` on `.cm-lp-macro-wrap`, but a GFM pipe table's root is `.cm-lp-table-wrap`
      // (TableWidget) — so a right-click whose posAtCoords overshoots the lezer `Table` node had NO wrap to
      // fall back through, and offered no Align. Include the table wraps so the same boundary rescue fires
      // for the pipe path (it now has a resolvable wrap element — a consequence of the §1 hover-chrome work).
      const wrapEl = (e.target as HTMLElement | null)?.closest?.(".cm-lp-macro-wrap, .cm-lp-table-wrap, .cm-lp-table-edit") as HTMLElement | null;
      let wrapPos: number | null = null;
      if (wrapEl) { try { wrapPos = view.posAtDOM(wrapEl); } catch { wrapPos = null; } }
      const diagramFrom = diagramFenceAt(view.state, pos) ?? (wrapPos != null ? diagramFenceAt(view.state, wrapPos) : null) ?? undefined;
      const imageFrom = imageAlignAt(view.state, pos) ?? (wrapPos != null ? imageAlignAt(view.state, wrapPos) : null) ?? undefined; // #255: standalone image alignment
      // #393 (+): resolve a `:::table` first, then fall back to a GFM pipe table at the click —
      // both offer alignment (the pipe path promotes on pick). The widget-position fallback is the
      // same tall-block-widget guard the diagram path documents above.
      const tableFrom = tableDirectiveAt(view.state, pos)
        ?? (wrapPos != null ? tableDirectiveAt(view.state, wrapPos) : null)
        ?? tableBlockAt(view.state, pos)?.from
        ?? (wrapPos != null ? tableBlockAt(view.state, wrapPos)?.from : null)
        ?? undefined;
      // #456 S4: a plain code fence (```lang …) offers its declared settings. Diagrams have their own
      // registry macro and their own entries, so only an unregistered fence lands here.
      const codeFenceFrom = codeFenceLineAt(view.state, pos) ?? undefined;
      // #325 slice 2b: on a plain (no-selection, no-link) right-click, offer "Copy block reference" for the block under the cursor.
      const blockRef = kind === "plain" ? (blockRefTarget(view.state, pos, view.state.facet(selfPageIdFacet)) ?? undefined) : undefined;
      view.dispatch({ effects: openMenu.of({ pos, kind, link, diagramFrom, imageFrom, tableFrom, blockRef, codeFenceFrom }) });
      e.preventDefault();
      return true;
    },
    keydown(e, view) {
      if (e.key === "Escape" && view.state.field(menuField, false)) {
        view.dispatch({ effects: closeMenu.of(null) });
        e.preventDefault();
        return true;
      }
      return false;
    },
  }),
);

// #456 S4: the opening line of the code fence CONTAINING `pos`, or null. The click usually lands on a
// body line, so resolve up to the fence that opens the block.
// #456 shared with the settings panel's keyboard command + hover hint, so the mouse (context menu),
// the keyboard, and the hover affordance all resolve "the code fence enclosing this position" identically.
// #456 the old regex up-scan required an info string on the opening line (to disambiguate it from
// a closing fence), so a BARE ``` fence — the block whose language you most want to SET — silenced all
// three affordances. The syntax tree knows open from close regardless of the info string, so it is the
// primary; ~~~ and indented fences come along for free.
export function codeFenceOpeningAt(state: import("@codemirror/state").EditorState, pos: number): number | null {
  return codeFenceLineAt(state, pos);
}

function codeFenceLineAt(state: import("@codemirror/state").EditorState, pos: number): number | null {
  const doc = state.doc;
  const clamped = Math.min(Math.max(pos, 0), doc.length);
  // Both sides, like macroFenceAt: a position at the block's far edge misses the node with one side only.
  for (const side of [1, -1] as const) {
    let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(clamped, side);
    while (node && node.name !== "FencedCode") node = node.parent;
    if (node) return doc.lineAt(node.from).from;
  }
  // #174: a fence nested inside a directive container is NOT a FencedCode node in the whole-doc tree
  // (the directive body isn't block-reparsed). Pair fences with a forward scan from the top — unlike the
  // old up-scan, pairing keeps a bare ``` unambiguous (the first fence line opens, the next matching
  // bare one closes).
  const posLine = doc.lineAt(clamped).number;
  let open: { lineFrom: number; lineNo: number; marker: string; len: number } | null = null;
  for (let n = 1; n <= doc.lines; n++) {
    if (!open && n > posLine) return null; // past pos with no fence open → pos isn't inside one
    const line = doc.line(n);
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (!m) continue;
    if (!open) {
      open = { lineFrom: line.from, lineNo: n, marker: m[1]![0]!, len: m[1]!.length };
    } else if (m[1]![0] === open.marker && m[1]!.length >= open.len && m[2]!.trim() === "") {
      // the closing fence (same marker, at least as long, no info string)
      if (posLine >= open.lineNo && posLine <= n) return open.lineFrom;
      open = null;
    }
  }
  return open && posLine >= open.lineNo ? open.lineFrom : null; // unterminated fence runs to the doc end
}

export function contextMenu(opts: { selfPageId?: string } = {}): Extension {
  return [menuField, menuEvents, selfPageIdFacet.of(opts.selfPageId)];
}
