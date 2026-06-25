import { describe, it, expect } from "vitest";
import { parsePipe, parseHtml, toHtml, toPipe, hasSpans, mergeRect, unmergeAt, serialize } from "./table-model";

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
