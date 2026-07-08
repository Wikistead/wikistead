import { describe, it, expect } from "vitest";
import { parseFenceInfo, serializeFenceInfo, parseFenceLine } from "@wikistead/macro-render";

// #198 / ADR-094: the extensible code-fence info parser (lang + attributes).
describe("parseFenceInfo (#198)", () => {
  it("parses lang + title + showLineNumbers + highlight ranges", () => {
    const f = parseFenceInfo(`ts title="app.ts" showLineNumbers {1,3-5}`);
    expect(f.lang).toBe("ts");
    expect(f.title).toBe("app.ts");
    expect(f.showLineNumbers).toBe(true);
    expect(f.highlight).toEqual([[1, 1], [3, 5]]);
  });

  it("handles a title with spaces (quoted) and single quotes", () => {
    expect(parseFenceInfo(`js title="my file.js"`).title).toBe("my file.js");
    expect(parseFenceInfo(`js title='other.js'`).title).toBe("other.js");
  });

  it("PRESERVES unknown attributes verbatim (extensible container)", () => {
    const f = parseFenceInfo(`py wrap copyable="yes"`);
    expect(f.extra).toEqual(["wrap", `copyable="yes"`]);
  });

  it("round-trips: parse ∘ serialize is stable", () => {
    const src = `ts title="app.ts" showLineNumbers {1,3-5} wrap`;
    const once = serializeFenceInfo(parseFenceInfo(src));
    expect(serializeFenceInfo(parseFenceInfo(once))).toBe(once);
    expect(once).toContain(`title="app.ts"`);
    expect(once).toContain("{1,3-5}");
    expect(once).toContain("wrap");
  });

  it("parseFenceLine strips the ``` / ~~~ markers", () => {
    expect(parseFenceLine("```ts title=\"a.ts\"")?.lang).toBe("ts");
    expect(parseFenceLine("~~~py {2}")?.highlight).toEqual([[2, 2]]);
    expect(parseFenceLine("not a fence")).toBeNull();
  });

  it("bare lang, no attributes", () => {
    const f = parseFenceInfo("mermaid");
    expect(f.lang).toBe("mermaid");
    expect(f.title).toBeUndefined();
    expect(f.extra).toEqual([]);
  });

  // #255: the `align=` attribute for diagram fences. center is the default and MUST NOT serialize
  // (existing docs stay unchanged); only left/right round-trip.
  it("parses align=left|right|center and defaults to undefined", () => {
    expect(parseFenceInfo("mermaid align=left").align).toBe("left");
    expect(parseFenceInfo("mermaid align=right").align).toBe("right");
    expect(parseFenceInfo("mermaid align=center").align).toBe("center");
    expect(parseFenceInfo("mermaid").align).toBeUndefined();
    expect(parseFenceInfo("mermaid align=bogus").align).toBeUndefined(); // invalid → not set (kept in extra)
  });

  it("serializes only left/right (center is the default = no attribute)", () => {
    expect(serializeFenceInfo({ lang: "mermaid", align: "left", extra: [] })).toBe("mermaid align=left");
    expect(serializeFenceInfo({ lang: "mermaid", align: "right", extra: [] })).toBe("mermaid align=right");
    expect(serializeFenceInfo({ lang: "mermaid", align: "center", extra: [] })).toBe("mermaid");
    expect(serializeFenceInfo({ lang: "mermaid", extra: [] })).toBe("mermaid");
  });

  it("round-trips align alongside title (order-independent parse)", () => {
    const f = parseFenceLine('```mermaid title="Flow" align=right');
    expect(f?.align).toBe("right");
    expect(f?.title).toBe("Flow");
    expect(serializeFenceInfo(f!)).toBe('mermaid title="Flow" align=right');
  });
});
