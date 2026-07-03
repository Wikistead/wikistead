import type { DirectiveMacro } from "./registry";
import { renderMarkdownToDom } from "./md-render";
// #85 slice 2: the DOM-free export half (parseLayoutItems + the htmlRenders) is the single source of
// truth in @wikistead/macro-render, shared with the server export renderer. This file adds only the
// DOM liveRender + editor metadata on top.
import { parseLayoutItems, columnsHtmlRender, tabsHtmlRender, detailsHtmlRender } from "@wikistead/macro-render";

export { parseLayoutItems }; // re-export: existing editor imports (tabs/columns liveRender + tests) unchanged

// M2 layout directives (#90, ADR-043 A′): columns / tabs. These need a side-by-side / tab frame
// that CodeMirror line decorations can't provide, so they render as a BLOCK-WIDGET ATOM (the
// table/mermaid model) that lays out its inner :::column / :::tab items, rendering each item's
// Markdown via the sanitized S0 renderer (the widget can't reach CM's renderers). Editing is
// reveal-on-cursor (revealOnCursor: the whole raw block shows while the caret is inside).

export const columnsMacro: DirectiveMacro = {
  kind: "directive",
  name: "columns",
  exportFidelity: "preserve", // ::: stays plain text → lossless round-trip
  revealOnCursor: true, // edit via reveal-on-cursor (raw source), not a modal
  slash: {
    labelKey: "palette.columns",
    keywords: "columns layout grid side-by-side",
    insert: "::::columns\n:::column\n\n:::\n:::column\n\n:::\n::::",
    caret: 22, // ":::​:columns\n:::column\n" → the first column's blank body line
  },
  liveRender: (body) => {
    const row = document.createElement("div");
    row.className = "cm-lp-columns";
    row.setAttribute("data-testid", "macro-columns");
    for (const c of parseLayoutItems(body, "column")) {
      const col = document.createElement("div");
      col.className = "cm-lp-column";
      col.appendChild(renderMarkdownToDom(c.content));
      row.appendChild(col);
    }
    return row;
  },
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

export const tabsMacro: DirectiveMacro = {
  kind: "directive",
  name: "tabs",
  exportFidelity: "preserve",
  revealOnCursor: true,
  slash: {
    labelKey: "palette.tabs",
    keywords: "tabs tabbed panels sections",
    insert: "::::tabs\n:::tab[Tab 1]\n\n:::\n:::tab[Tab 2]\n\n:::\n::::",
    caret: 23, // "::::tabs\n:::tab[Tab 1]\n" → the first tab's blank body line
  },
  liveRender: (body) => {
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
      panel.appendChild(renderMarkdownToDom(t.content));
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
  },
  // #85/#90 export degrade (meaning-preserving: label → visible heading + body). Single source of
  // truth in @wikistead/macro-render, shared with the server export renderer.
  htmlRender: tabsHtmlRender,
};
