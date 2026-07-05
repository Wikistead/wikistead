// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { gridToTable, renderHtmlTable } from "./table";
import { toHtml, type TCell } from "./table-model";

// #89 / ADR-097 (client render): a `block` cell renders its Markdown through the shared sanitized DOM
// renderer (renderMarkdownToDom) mounted as a subtree — real block elements, and a raw <iframe>/<script>
// in the cell degrades to escaped text (never a live tag), so a table cell can't smuggle past the embed
// gates. The XSS boundary (ADR-037) holds: a trusted sanitized subtree is mounted, never user innerHTML.
describe("table block-content cell — client DOM render (#89 / ADR-097)", () => {
  const block = (text: string): TCell => ({ text, header: false, colspan: 1, rowspan: 1, block: true });
  const plain = (text: string): TCell => ({ text, header: false, colspan: 1, rowspan: 1 });

  it("renders a block cell's Markdown list as real <ul>/<li> nodes inside the <td>", () => {
    const table = gridToTable([[block("- one\n- two")]]);
    const td = table.querySelector("td")!;
    expect(td.classList.contains("cm-lp-cell-block")).toBe(true);
    expect(td.querySelectorAll("ul li").length).toBe(2);
    expect(td.textContent).toContain("one");
    expect(td.textContent).toContain("two");
  });

  it("a raw <iframe>/<script> in a block cell is NOT a live element (allowlist degrades it to text)", () => {
    const table = gridToTable([[block("- <iframe src=https://evil.example></iframe>\n- <script>alert(1)</script>")]]);
    const td = table.querySelector("td")!;
    expect(td.querySelector("iframe")).toBeNull(); // no live frame — the smuggling threat is closed
    expect(td.querySelector("script")).toBeNull();
    expect(td.textContent).toContain("<iframe"); // present only as inert text
  });

  it("a plain cell renders text (no block subtree) — no regression", () => {
    const table = gridToTable([[plain("hello"), plain("a\nb")]]);
    const [c1, c2] = Array.from(table.querySelectorAll("td"));
    expect(c1!.classList.contains("cm-lp-cell-block")).toBe(false);
    expect(c1!.querySelector("ul")).toBeNull();
    expect(c1!.textContent).toBe("hello");
    expect(c2!.querySelectorAll("br").length).toBe(1); // in-cell newline stays a <br>
  });

  it("round-trips through the :::table wire form: toHtml → renderHtmlTable renders the block cell", () => {
    const wire = toHtml([[block("1. a\n2. b")]]); // <table>…<td data-block="1">…</td>…</table>
    const td = renderHtmlTable(wire).querySelector("td")!;
    expect(td.classList.contains("cm-lp-cell-block")).toBe(true);
    expect(td.querySelectorAll("ol li").length).toBe(2); // ordered list survived the round-trip + render
  });
});
