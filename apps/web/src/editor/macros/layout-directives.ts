import type { DirectiveMacro } from "./registry";
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

// #278 §2a: the #257 STRUCTURED editUI panel is RETIRED. A container's content is now edited by an inline CM6
// island in the clicked slot (decorations.ts mountSlotEditIsland) and its structure by the per-item inline ×/
// (§1) — so this file no longer exposes an editUI; the container stays a flex-widget ATOM (layout never breaks,
// #196), the caret never reveals raw, and single Y.Text is preserved by the island's commit-on-blur range edit.

export function columnsLiveRender(body: string): HTMLElement {
  const base = takePendingBaseOffset(); // #215 / ADR-100: absolute base of `body` (null = untagged render)
  const row = document.createElement("div");
  row.className = "cm-lp-columns";
  row.setAttribute("data-testid", "macro-columns");
  for (const c of parseLayoutItems(body, "column")) {
    const col = document.createElement("div");
    col.className = "cm-lp-column";
    if (!c.content.trim()) col.classList.add("cm-lp-column-empty"); // #278H: hover affordance for an empty slot
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
  // #278 §2a: NO editUI panel — a column's content is edited by an inline CM6 island in the slot (click it);
  // structure ops are the per-item inline ×/ (§1). The #257 panel is retired (the user's "no panel" ask,).
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

// #174 point 2: the active tab is DISPLAY-ONLY state, but #174 (5b69765) put selection/wysiwyg into the
// MacroWidget's eq/updateDOM keys, so clicking a nested macro now re-renders the tabs widget on EVERY click
// — which used to reset the active tab to the first (the v1 "resets on re-render" caveat broke in practice).
// Persist the active index across re-renders in a module-level Map keyed by the tabs macro's anchor (`base`,
// the absolute doc offset of its body — stable while the doc above is unchanged). Pure display state: no
// doc/offset/presence is touched (same discipline as nestedSelectionField). Safe as a module singleton for
// the same reason as the render-depth counter — rendering is fully synchronous.
const tabActiveIndex = new Map<number, number>();

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
    if (!t.content.trim()) panel.classList.add("cm-lp-tabpanel-empty"); // #278H: hover affordance for an empty tab
    panel.appendChild(renderMarkdownToDom(t.content, base != null ? base + t.contentOffset : undefined));
    const activate = () => {
      for (const b of Array.from(bar.children)) b.classList.toggle("cm-lp-tab-active", b === btn);
      for (const p of Array.from(panels.children)) (p as HTMLElement).classList.toggle("cm-lp-tabpanel-active", p === panel);
      if (base != null) tabActiveIndex.set(base, i); // #174 point 2: remember across re-renders (display-only)
    };
    // Switching tabs is DISPLAY-ONLY local state. stopPropagation so a tab click doesn't enter the atom.
    btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); activate(); });
    bar.appendChild(btn);
    panels.appendChild(panel);
    // #174 point 2: restore the persisted active tab (keyed by the macro anchor) instead of always the first,
    // so a re-render triggered by a nested-macro click keeps the tab the user was on. Clamp to a valid index.
    const wantActive = Math.min(base != null ? (tabActiveIndex.get(base) ?? 0) : 0, items.length - 1);
    if (i === wantActive) activate();
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
  // #278 §2a: NO editUI panel — the active tab's content is edited by an inline CM6 island in its panel (click
  // it); structure ops are the per-item inline ×/ (§1). The #257 panel is retired.
  // #85/#90 export degrade (meaning-preserving: label → visible heading + body). Single source of
  // truth in @wikistead/macro-render, shared with the server export renderer.
  htmlRender: tabsHtmlRender,
};
