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

// #565 bug 2: a language-less fence's first token was consumed as the LANGUAGE, swallowing the
// attribute before interpretation started — and serializeFenceInfo emits exactly that shape for
// lang="", so the settings panel's own writes were unreadable (round-trip false for lang="").
describe("#565: language-less fences with a leading attribute", () => {
  it('```title="AA" — the attribute is a title, not a language', () => {
    const f = parseFenceInfo(`title="AA"`);
    expect(f.lang).toBe("");
    expect(f.title).toBe("AA");
  });
  it("```showLineNumbers — recognised, no language", () => {
    const f = parseFenceInfo("showLineNumbers");
    expect(f.lang).toBe("");
    expect(f.showLineNumbers).toBe(true);
  });
  it("```{1,3} — highlight ranges, no language", () => {
    const f = parseFenceInfo("{1,3}");
    expect(f.lang).toBe("");
    expect(f.highlight).toEqual([[1, 1], [3, 3]]);
  });
  it("```align=left — alignment, no language", () => {
    const f = parseFenceInfo("align=left");
    expect(f.lang).toBe("");
    expect(f.align).toBe("left");
  });
  it("round-trips with lang='' for every attribute combination", () => {
    for (const src of [`title="AA"`, "showLineNumbers", "{1,3}", "align=left", `title="AA" showLineNumbers {1,3-5}`]) {
      const parsed = parseFenceInfo(src);
      expect(parsed.lang, src).toBe("");
      const once = serializeFenceInfo(parsed);
      expect(serializeFenceInfo(parseFenceInfo(once)), src).toBe(once);
      const twice = parseFenceInfo(once);
      expect(twice.title, src).toBe(parsed.title);
      expect(twice.showLineNumbers, src).toBe(parsed.showLineNumbers);
      expect(twice.highlight, src).toEqual(parsed.highlight);
    }
  });
  it("a real language still wins the first slot (non-regression)", () => {
    expect(parseFenceInfo(`ts title="x.ts"`).lang).toBe("ts");
    expect(parseFenceInfo("mermaid").lang).toBe("mermaid");
    expect(parseFenceInfo(`py wrap copyable="yes"`).lang).toBe("py");
  });
});
