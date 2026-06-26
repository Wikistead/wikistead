import { describe, it, expect } from "vitest";
import { parsePipe, parseHtml, toHtml, toPipe, hasSpans, mergeRect, unmergeAt, serialize, sanitizeStyle, insertColAt, insertRowAt, deleteColAt, deleteRowAt, cellTextToHtml, htmlToCellText, representableAsPipe } from "./table-model";

// ADR-037 in-cell newlines: a cell newline is the only kept markup, as GFM <br>. The pair
// MUST round-trip with no <br> loss/duplication (the tiptap #7731 class of bug) and a
// multiline cell must force the :::table HTML tier (pipes can't hold a newline → lossless).
describe("table-model: in-cell newline <-> <br> round-trip (#86 / ADR-037)", () => {
  it("serializes an in-cell newline as <br> and parses it back to a newline", () => {
    expect(cellTextToHtml("a\nb")).toBe("a<br>b");
    expect(htmlToCellText("a<br>b")).toBe("a\nb");
  });

  it("round-trips multi-line cell text through toHtml -> parseHtml with no loss or duplication", () => {
    const grid = [[{ text: "line1\nline2\nline3", header: false, colspan: 1, rowspan: 1 }]];
    const back = parseHtml(toHtml(grid));
    expect(back[0]![0]!.text).toBe("line1\nline2\nline3"); // exactly preserved
  });

  it("parses both <br> and <br/> (hand-edited variants) to a single newline (no dup)", () => {
    expect(htmlToCellText("a<br>b<br/>c<br />d")).toBe("a\nb\nc\nd");
  });

  it("escapes <, >, & in cell text and never lets a tag survive as markup", () => {
    expect(cellTextToHtml("a<b>&c\nd")).toBe("a&lt;b&gt;&amp;c<br>d");
    // a pasted/hand-edited <b> tag is stripped (not kept as markup); only <br> -> newline
    expect(htmlToCellText("x<b>y</b><br>z")).toBe("xy\nz");
  });

  it("forces the :::table HTML tier for a multiline cell (a pipe would flatten the newline)", () => {
    const multiline = [[{ text: "a\nb", header: false, colspan: 1, rowspan: 1 }]];
    expect(representableAsPipe(multiline)).toBe(false);
    expect(serialize(multiline).tier).toBe("html");
    // a single-line grid still demotes to a pipe table
    const flat = [[{ text: "a", header: false, colspan: 1, rowspan: 1 }]];
    expect(representableAsPipe(flat)).toBe(true);
  });
});

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

// #1: add/remove rows & columns. Span-free is the common (pipe) case and must STAY pipe
// (Tier 1, no promotion); spans are kept consistent so a merged table never corrupts.
describe("table-model: insert/delete rows & columns", () => {
  it("inserts a column, keeps the table span-free (stays Tier-1 pipe)", () => {
    const g = parsePipe("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const w = insertColAt(g, 1); // between A and B
    expect(w[0]!.length).toBe(3);
    expect(w[0]!.map((c) => c!.text)).toEqual(["A", "", "B"]);
    expect(w[0]![1]).toMatchObject({ header: true }); // inserted into the header row → th
    expect(w[1]!.map((c) => c!.text)).toEqual(["1", "", "2"]);
    expect(serialize(w).tier).toBe("pipe"); // NO promotion — pure GFM
  });

  it("appends a column at the end and a row at the end", () => {
    const g = parsePipe("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const w = insertColAt(g, 2);
    expect(w[0]!.map((c) => c!.text)).toEqual(["A", "B", ""]);
    const r = insertRowAt(g, g.length); // append a body row
    expect(r.length).toBe(3);
    expect(r[2]!.map((c) => c!.text)).toEqual(["", ""]);
    expect(serialize(r).tier).toBe("pipe");
  });

  it("deletes a column and a row", () => {
    const g = parsePipe("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
    const dc = deleteColAt(g, 1); // drop column B
    expect(dc[0]!.map((c) => c!.text)).toEqual(["A", "C"]);
    expect(dc[1]!.map((c) => c!.text)).toEqual(["1", "3"]);
    const dr = deleteRowAt(g, 1); // drop the body row
    expect(dr.length).toBe(1);
    expect(dr[0]!.map((c) => c!.text)).toEqual(["A", "B", "C"]);
  });

  it("never deletes the last row or column", () => {
    const one = parsePipe("| A |\n| --- |\n| 1 |");
    expect(deleteColAt(one, 0)[0]!.length).toBe(1); // refused — still 1 col
    const oneRow = parsePipe("| A | B |"); // header-less single row
    expect(deleteRowAt(oneRow, 0).length).toBe(1); // refused — still 1 row
  });

  it("inserting a column inside a colspan widens the merged cell (no corruption)", () => {
    const g = parseHtml('<table><tr><td colspan="2">m</td></tr><tr><td>1</td><td>2</td></tr></table>');
    const w = insertColAt(g, 1); // boundary falls inside the colspan-2 origin
    expect(w[0]![0]).toMatchObject({ text: "m", colspan: 3 }); // widened, not split
    expect(w[0]![1]).toBeNull();
    expect(w[1]!.map((c) => c!.text)).toEqual(["1", "", "2"]); // body row gets a real cell
    // round-trips cleanly through HTML
    const re = parseHtml(toHtml(w));
    expect(re[0]![0]).toMatchObject({ colspan: 3 });
  });

  it("deleting a column shrinks a spanning cell instead of dropping content", () => {
    const g = parseHtml('<table><tr><td colspan="2">m</td></tr><tr><td>1</td><td>2</td></tr></table>');
    const d = deleteColAt(g, 0); // remove the first column under the span
    expect(d[0]![0]).toMatchObject({ text: "m", colspan: 1 }); // shrank to 1, kept text
    expect(d[1]!.map((c) => c!.text)).toEqual(["2"]);
  });
});
