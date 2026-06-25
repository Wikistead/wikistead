import { describe, it, expect } from "vitest";
import { parsePipe, parseHtml, toHtml, toPipe, hasSpans, mergeRect, unmergeAt, serialize, sanitizeStyle } from "./table-model";

describe("table-model: parse/serialize", () => {
  it("parses a GFM pipe table (row 0 = header, no spans)", () => {
    const g = parsePipe("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(g.length).toBe(2);
    expect(g[0]![0]).toMatchObject({ text: "A", header: true, colspan: 1, rowspan: 1 });
    expect(g[1]![1]).toMatchObject({ text: "2", header: false });
    expect(hasSpans(g)).toBe(false);
    expect(toPipe(g)).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("parses an HTML table with colspan/rowspan into a logical grid", () => {
    const g = parseHtml('<table><tr><th>A</th><th>B</th></tr><tr><td colspan="2">m</td></tr></table>');
    expect(g[0]!.length).toBe(2);
    expect(g[1]![0]).toMatchObject({ text: "m", colspan: 2 });
    expect(g[1]![1]).toBeNull(); // covered by the colspan
    expect(hasSpans(g)).toBe(true);
  });
});

// SECURITY-CRITICAL (ADR-022 review #2): the style allowlist is the XSS boundary for
// :::table HTML (rendered AND vim-hand-edited). Only background/color/width/text-align
// with safe values survive; everything else is dropped.
describe("table-model: style sanitization (XSS boundary)", () => {
  it("keeps only the four allowlisted properties with safe values", () => {
    expect(sanitizeStyle("background:#f00;text-align:center;width:120px;color:#012")).toEqual({ bg: "#f00", align: "center", width: "120px", color: "#012" });
    expect(sanitizeStyle("background:var(--accent)")).toEqual({ bg: "var(--accent)" });
  });
  it("drops dangerous values (javascript:/url()/expression) and non-allowlisted props", () => {
    expect(sanitizeStyle("background:url(javascript:alert(1))")).toBeUndefined();
    expect(sanitizeStyle("background:url(x);color:expression(alert(1))")).toBeUndefined();
    expect(sanitizeStyle("position:fixed;top:0;z-index:9999")).toBeUndefined();
    expect(sanitizeStyle("text-align:right;behavior:url(x.htc)")).toEqual({ align: "right" }); // keep good, drop bad
    expect(sanitizeStyle("width:100vw")).toBeUndefined(); // only px/% allowed
    expect(sanitizeStyle("height:40px")).toEqual({ height: "40px" }); // row height allowed
    expect(sanitizeStyle("height:100vh")).toBeUndefined(); // only px/% allowed
    expect(sanitizeStyle("color:red")).toBeUndefined(); // only hex/var() allowed
  });
  it("parseHtml routes cell style through the allowlist (drops malicious style + ignores other attrs/tags)", () => {
    const g = parseHtml('<table><tr><td style="background:#abc;position:fixed" onclick="evil()">x</td></tr></table>');
    expect(g[0]![0]!.style).toEqual({ bg: "#abc" }); // position dropped, onclick never read
    const g2 = parseHtml('<table><tr><td style="background:url(javascript:alert(1))">y</td></tr></table>');
    expect(g2[0]![0]!.style).toBeUndefined(); // dangerous value dropped entirely
    // toHtml only ever emits the sanitized style (no script can survive a round-trip)
    expect(toHtml(g2)).not.toContain("javascript");
  });
});

describe("table-model: merge → promote, unmerge → demote", () => {
  it("merging two cells in a row promotes to HTML (colspan)", () => {
    const g = parsePipe("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const merged = mergeRect(g, 1, 0, 1, 1); // merge the body row's two cells
    expect(merged[1]![0]).toMatchObject({ text: "1 2", colspan: 2 });
    expect(merged[1]![1]).toBeNull();
    const s = serialize(merged);
    expect(s.tier).toBe("html"); // promotion
    expect(s.text).toContain('colspan="2"');
  });

  it("unmerging the last span demotes back to a pipe table", () => {
    const g = parseHtml('<table><tr><td>A</td><td>B</td></tr><tr><td colspan="2">m</td></tr></table>');
    expect(serialize(g).tier).toBe("html");
    const split = unmergeAt(g, 1, 0); // un-merge the colspan cell
    expect(split[1]![1]).toMatchObject({ colspan: 1 }); // restored
    expect(hasSpans(split)).toBe(false);
    expect(serialize(split).tier).toBe("pipe"); // demotion
  });

  it("a style (color/align) promotes a pipe table to HTML, and clearing it demotes", () => {
    const g = parsePipe("| A | B |\n| --- | --- |\n| 1 | 2 |");
    g[1]![0]!.style = { align: "center", bg: "#fee" };
    expect(serialize(g).tier).toBe("html");
    expect(serialize(g).text).toContain('style="background:#fee;text-align:center"');
    delete g[1]![0]!.style;
    expect(serialize(g).tier).toBe("pipe"); // demote when the style is gone
  });

  it("a header in a body row (complex header) promotes to HTML", () => {
    const g = parsePipe("| A | B |\n| --- | --- |\n| 1 | 2 |");
    g[1]![0]!.header = true; // a <th> in the body → not pipe-expressible
    expect(serialize(g).tier).toBe("html");
  });

  it("a rowspan merge round-trips through HTML", () => {
    const g = parsePipe("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
    const merged = mergeRect(g, 1, 0, 2, 0); // merge column 0 of the two body rows
    expect(merged[1]![0]).toMatchObject({ rowspan: 2, text: "1 3" });
    expect(merged[2]![0]).toBeNull();
    const reparsed = parseHtml(toHtml(merged));
    expect(reparsed[1]![0]).toMatchObject({ rowspan: 2 });
    expect(reparsed[2]![0]).toBeNull();
  });
});
