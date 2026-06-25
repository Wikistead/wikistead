import type { DirectiveMacro } from "./registry";

// :::table — the Tier-2 table macro. Body is an HTML <table> (rowspan/colspan), which
// a GFM pipe table promotes to when a merge is added (ADR-022 Part 10). The cell-merge
// mouse UI (promote/demote) lands in the next commit; here is the render + round-trip.

// Render an HTML <table> body to a SANITIZED table element. XSS-safe: we never inject
// the raw HTML — DOMParser reads it, and we rebuild a clean DOM with textContent cells
// and only the colspan/rowspan integer attributes.
export function renderHtmlTable(html: string): HTMLTableElement {
  const out = document.createElement("table");
  out.className = "cm-lp-table cm-lp-table-merged";
  const src = new DOMParser().parseFromString(html, "text/html").querySelector("table");
  if (!src) return out;
  for (const srcRow of Array.from(src.querySelectorAll("tr"))) {
    const tr = document.createElement("tr");
    for (const srcCell of Array.from(srcRow.querySelectorAll("th,td"))) {
      const cell = document.createElement(srcCell.tagName.toLowerCase() === "th" ? "th" : "td");
      cell.textContent = srcCell.textContent ?? "";
      const cs = srcCell.getAttribute("colspan");
      const rs = srcCell.getAttribute("rowspan");
      if (cs && /^\d+$/.test(cs)) cell.colSpan = Number(cs);
      if (rs && /^\d+$/.test(rs)) cell.rowSpan = Number(rs);
      tr.appendChild(cell);
    }
    out.appendChild(tr);
  }
  return out;
}

export const tableMacro: DirectiveMacro = {
  kind: "directive",
  name: "table",
  exportFidelity: "preserve", // HTML is standard Markdown; round-trips verbatim
  richEditUI: { present: "inline" },
  liveRender: (body) => {
    const el = renderHtmlTable(body);
    el.setAttribute("data-testid", "macro-table");
    return el;
  },
  // The body is already HTML → it round-trips as-is. (M3 server export must sanitize
  // before serving to other users.)
  htmlRender: (body) => body,
};
