import type { DirectiveMacro, EditUI } from "./registry";
import { asMacroSource } from "./registry";
import { renderMarkdownToDom, takePendingBaseOffset } from "./md-render";
// #85 slice 2: the DOM-free export half (parseLayoutItems + the htmlRenders) is the single source of
// truth in @wikistead/macro-render, shared with the server export renderer. This file adds only the
// DOM liveRender + editor metadata on top.
import { parseLayoutItems, columnsHtmlRender, tabsHtmlRender, detailsHtmlRender } from "@wikistead/macro-render";

export { parseLayoutItems }; // re-export: existing editor imports (tabs/columns liveRender + tests) unchanged

// M2 layout directives (#90, ADR-043 A′): columns / tabs. These need a side-by-side / tab frame
// that CodeMirror line decorations can't provide, so they render as a BLOCK-WIDGET ATOM (the
// table/mermaid model) that lays out its inner :::column / :::tab items, rendering each item's
// Markdown via the sanitized S0 renderer (the widget can't reach CM's renderers).
//
// #196 comment 786 (Option B, variant i): columns/tabs are edited via an editUI PANEL, NOT reveal-on-cursor.
// A caret-in reveal cannot keep the side-by-side flex layout (a flex box is an atomic widget; raw editable
// text is CM lines — they can't co-exist in the same column slot, so reveal collapsed the layout vertically,
// the #196/754 breakage). So the container stays a flex widget ALWAYS (layout never breaks) and its raw
// source is edited in a split panel (source textarea + live preview), reached via the single edit button.

// The shared inline editUI for a layout container: a source textarea + a live preview rendered by the
// macro's OWN liveRender (so the panel shows exactly what the block will look like). Save on change (blur),
// not per keystroke (a per-keystroke Y.Text write re-mounts the widget and resets the textarea).
function layoutEditUI(liveRender: (body: string) => HTMLElement): EditUI {
  return {
    present: "inline",
    mount(container, source, _ctx, save) {
      const wrap = document.createElement("div");
      wrap.className = "cm-lp-layout-edit";
      const ta = document.createElement("textarea");
      ta.className = "cm-lp-layout-edit-src";
      ta.value = source;
      ta.spellcheck = false;
      ta.setAttribute("data-testid", "layout-edit-src");
      const preview = document.createElement("div");
      preview.className = "cm-lp-layout-edit-preview";
      preview.setAttribute("data-testid", "layout-edit-preview");
      const renderPreview = (body: string) => { try { preview.replaceChildren(liveRender(body)); } catch { preview.textContent = ""; } };
      ta.addEventListener("input", () => renderPreview(ta.value)); // local live preview, no doc write
      ta.addEventListener("change", () => save(asMacroSource(ta.value))); // commit to Y.Text on blur
      renderPreview(source);
      wrap.append(ta, preview);
      container.appendChild(wrap);
      const focus = setTimeout(() => ta.focus(), 0);
      return { destroy() { clearTimeout(focus); wrap.remove(); } };
    },
  };
}

export function columnsLiveRender(body: string): HTMLElement {
  const base = takePendingBaseOffset(); // #215 / ADR-100: absolute base of `body` (null = untagged render)
  const row = document.createElement("div");
  row.className = "cm-lp-columns";
  row.setAttribute("data-testid", "macro-columns");
  for (const c of parseLayoutItems(body, "column")) {
    const col = document.createElement("div");
    col.className = "cm-lp-column";
    // The column SLOT is not tagged (a click on empty slot area selects the container, ADR-100 §1);
    // only real nested macros inside get data-mac-pos, via renderMarkdownToDom with the column base.
    col.appendChild(renderMarkdownToDom(c.content, base != null ? base + c.contentOffset : undefined));
    row.appendChild(col);
  }
  return row;
}

export const columnsMacro: DirectiveMacro = {
  kind: "directive",
  name: "columns",
  exportFidelity: "preserve", // ::: stays plain text → lossless round-trip
  slash: {
    labelKey: "palette.columns",
    keywords: "columns layout grid side-by-side",
    insert: "::::columns\n:::column\n\n:::\n:::column\n\n:::\n::::",
    caret: 22, // ":::​:columns\n:::column\n" → the first column's blank body line
  },
  liveRender: columnsLiveRender,
  editUI: layoutEditUI(columnsLiveRender), // #196 comment 786: panel edit, not reveal (layout never breaks)
  htmlRender: columnsHtmlRender, // #85: single source of truth in @wikistead/macro-render
};

export const detailsMacro: DirectiveMacro = {
  kind: "directive",
  name: "details",
  containerClass: "cm-lp-details",
  collapsible: true, // caret-away → "▸ summary" bar; caret-in → raw editable (reveal-on-cursor)
  exportFidelity: "preserve",
  slash: {
    labelKey: "palette.details",
    keywords: "details collapsible summary fold accordion toggle",
    insert: ":::details[Summary]\n\n:::",
    caret: 20, // ":::details[Summary]\n" → the blank body line
  },
  htmlRender: detailsHtmlRender, // #85: single source of truth in @wikistead/macro-render
};

export function tabsLiveRender(body: string): HTMLElement {
  const base = takePendingBaseOffset(); // #215 / ADR-100: absolute base of `body` (null = untagged render)
  const items = parseLayoutItems(body, "tab");
  const wrap = document.createElement("div");
  wrap.className = "cm-lp-tabs";
  wrap.setAttribute("data-testid", "macro-tabs");
  const bar = document.createElement("div");
  bar.className = "cm-lp-tabbar";
  const panels = document.createElement("div");
  panels.className = "cm-lp-tabpanels";
  items.forEach((t, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-lp-tab";
    btn.textContent = t.label || `Tab ${i + 1}`;
    const panel = document.createElement("div");
    panel.className = "cm-lp-tabpanel";
    panel.appendChild(renderMarkdownToDom(t.content, base != null ? base + t.contentOffset : undefined));
    const activate = () => {
      for (const b of Array.from(bar.children)) b.classList.toggle("cm-lp-tab-active", b === btn);
      for (const p of Array.from(panels.children)) (p as HTMLElement).classList.toggle("cm-lp-tabpanel-active", p === panel);
    };
    // Switching tabs is DISPLAY-ONLY local state (resets on a re-render — acceptable v1; doc/
    // offset/presence untouched). stopPropagation so a tab click doesn't enter the atom (reveal).
    btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); activate(); });
    bar.appendChild(btn);
    panels.appendChild(panel);
    if (i === 0) activate(); // default to the first tab (after both are in the DOM)
  });
  wrap.append(bar, panels);
  return wrap;
}

export const tabsMacro: DirectiveMacro = {
  kind: "directive",
  name: "tabs",
  exportFidelity: "preserve",
  slash: {
    labelKey: "palette.tabs",
    keywords: "tabs tabbed panels sections",
    insert: "::::tabs\n:::tab[Tab 1]\n\n:::\n:::tab[Tab 2]\n\n:::\n::::",
    caret: 23, // "::::tabs\n:::tab[Tab 1]\n" → the first tab's blank body line
  },
  liveRender: tabsLiveRender,
  editUI: layoutEditUI(tabsLiveRender), // #196 comment 786: panel edit, not reveal (layout never breaks)
  // #85/#90 export degrade (meaning-preserving: label → visible heading + body). Single source of
  // truth in @wikistead/macro-render, shared with the server export renderer.
  htmlRender: tabsHtmlRender,
};
