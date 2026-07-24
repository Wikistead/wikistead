// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderHtmlTable, tableMacro } from "./table";

// #518: the :::table macro must produce a structure the shared sticky-header CSS can actually pin.
// The device trace found the regression here: gridToTable put every <tr> straight under <table>
// (no <thead>, so `.cm-lp-table thead th` never matched → header th had `top: auto`, inert), and the
// liveRender returned the bare <table> (no `.cm-lp-table-scroll` box → a wide table scrolled the whole
// editor and a tall one had no vertical scroll box for the header to pin against). These pin the DOM
// contract for BOTH the editor MacroWidget and the read `.wks-prose` surface (both call these fns).

describe("#518 :::table sticky-header DOM contract", () => {
  it("gridToTable groups the leading header row into a <thead>, body rows into <tbody>", () => {
    const t = renderHtmlTable("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
    const thead = t.querySelector("thead");
    const tbody = t.querySelector("tbody");
    expect(thead, "a leading all-<th> row becomes a <thead>").not.toBeNull();
    expect(thead!.querySelectorAll("th")).toHaveLength(2);
    expect(tbody!.querySelectorAll("td")).toHaveLength(2);
    // the shared sticky selector `.cm-lp-table thead th` now has a target
    expect(t.matches(".cm-lp-table")).toBe(true);
    expect(t.querySelector("thead th")).not.toBeNull();
  });

  it("keeps a body row-header (first-column <th>) in <tbody>, not <thead>", () => {
    // header row, then a body row whose first cell is a <th> (a row label) — that th sticks LEFT, not top
    const t = renderHtmlTable("<table><tr><th>A</th><th>B</th></tr><tr><th>row</th><td>2</td></tr></table>");
    expect(t.querySelectorAll("thead tr")).toHaveLength(1); // ONLY the leading all-header row
    const bodyTr = t.querySelector("tbody tr")!;
    expect(bodyTr.querySelector("th")!.textContent).toBe("row"); // the row-header stayed in the body
  });

  it("liveRender wraps the table in a .cm-lp-table-scroll box (the local scroll container)", () => {
    const el = tableMacro.liveRender!("<table><tr><th>A</th></tr><tr><td>1</td></tr></table>", { theme: "dark" });
    expect(el.classList.contains("cm-lp-table-scroll"), "the macro root is the scroll box").toBe(true);
    const table = el.querySelector("table.cm-lp-table.cm-lp-table-merged");
    expect(table, "the box holds the merged table").not.toBeNull();
    expect(table!.getAttribute("data-testid")).toBe("macro-table"); // testid stays on the table
    expect(table!.querySelector("thead th"), "the wrapped table still has a sticky-able thead").not.toBeNull();
  });

  it("a table with no header row emits no <thead> (nothing to pin), all rows in <tbody>", () => {
    const t = renderHtmlTable("<table><tr><td>1</td><td>2</td></tr></table>");
    expect(t.querySelector("thead")).toBeNull();
    expect(t.querySelectorAll("tbody td")).toHaveLength(2);
  });
});
