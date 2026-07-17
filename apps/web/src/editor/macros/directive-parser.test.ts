import { describe, it, expect } from "vitest";
import { parser } from "@lezer/markdown";
import { directiveExtension, parseDirectiveOpen, isDirectiveClose, resolveDirectiveRanges, serializeDirectiveAttrs } from "./directive-parser";

const p = parser.configure(directiveExtension);

// Collect "Name[from,to]" for every node, in document order.
function nodes(src: string): string[] {
  const out: string[] = [];
  p.parse(src).iterate({ enter: (n) => { out.push(`${n.name}[${n.from},${n.to}]`); } });
  return out;
}

describe("directive fence matchers", () => {
  it("recognizes an opening fence with a name (+ optional attrs)", () => {
    expect(parseDirectiveOpen(":::callout")).toEqual({ colons: 3, name: "callout" });
    expect(parseDirectiveOpen(":::note{type=warn}")).toEqual({ colons: 3, name: "note", attrs: { type: "warn" } }); // #393: attrs parse now
    expect(parseDirectiveOpen("::::columns")).toEqual({ colons: 4, name: "columns" });
    expect(parseDirectiveOpen(":::")).toBeNull(); // no name → not an opening
    expect(parseDirectiveOpen("text")).toBeNull();
  });
  it("parses an optional leading [label] / custom header (#94)", () => {
    expect(parseDirectiveOpen(":::callout[My Note]")).toEqual({ colons: 3, name: "callout", label: "My Note" });
    expect(parseDirectiveOpen(":::note[Heads up]{type=warn}")).toEqual({ colons: 3, name: "note", label: "Heads up", attrs: { type: "warn" } }); // #393
    expect(parseDirectiveOpen(":::callout[  spaced  ]")).toEqual({ colons: 3, name: "callout", label: "spaced" }); // trimmed
    expect(parseDirectiveOpen(":::callout[]")).toEqual({ colons: 3, name: "callout" }); // empty → no label
    expect(parseDirectiveOpen(":::callout")).toEqual({ colons: 3, name: "callout" }); // unchanged (no label)
  });
  it("tolerates trailing content after the label (no fall-back to Markdown) — #94 bug", () => {
    // The old strict `$` made these FAIL → the line became a paragraph and the `[..]` linkified.
    expect(parseDirectiveOpen(":::callout[a]b]")).toEqual({ colons: 3, name: "callout", label: "a" });
    expect(parseDirectiveOpen(":::callout[a] trailing")).toEqual({ colons: 3, name: "callout", label: "a" });
    expect(parseDirectiveOpen(":::warning[サーバ停止のお知らせ]")).toEqual({ colons: 3, name: "warning", label: "サーバ停止のお知らせ" });
  });
  it("recognizes a closing fence (>= opening colon count)", () => {
    expect(isDirectiveClose(":::", 3)).toBe(true);
    expect(isDirectiveClose("::::", 3)).toBe(true); // longer closes a shorter open
    expect(isDirectiveClose(":::", 4)).toBe(false); // too short for a :::: open
    expect(isDirectiveClose(":::callout", 3)).toBe(false); // has a name → opening, not close
  });
});

describe("directive parser (composite, nested markdown)", () => {
  it("wraps content in a Directive with fence marks and parses content as Markdown", () => {
    const src = ":::callout\n**hi**\n:::\n";
    const ns = nodes(src);
    // a Directive node spanning the whole block
    expect(ns.some((n) => n.startsWith("Directive["))).toBe(true);
    // two fence marks (open + close)
    expect(ns.filter((n) => n.startsWith("DirectiveMark[")).length).toBe(2);
    // nested markdown inside: the **hi** is parsed (StrongEmphasis), proving content is
    // Markdown, not opaque — the existing renderers will decorate it for free.
    expect(ns.some((n) => n.startsWith("StrongEmphasis["))).toBe(true);
  });

  it("the Directive spans from the opening ::: to the closing :::", () => {
    const src = ":::callout\nbody\n:::\n";
    const dir = nodes(src).find((n) => n.startsWith("Directive["))!;
    const [, from, to] = /Directive\[(\d+),(\d+)\]/.exec(dir)!;
    expect(Number(from)).toBe(0);
    expect(Number(to)).toBeGreaterThanOrEqual(src.indexOf(":::", 1) + 3); // includes closing fence
  });

  it("leaves a lone ::: (no name) as ordinary text, not a Directive", () => {
    expect(nodes("just text\n").some((n) => n.startsWith("Directive["))).toBe(false);
  });

  it("interrupts an open paragraph: `text\\n:::name` parses the directive (endLeaf, #91)", () => {
    // Without endLeaf, a directive line right after a paragraph (no blank line) was absorbed
    // as a lazy continuation → no Directive node → the macro never rendered and vim dd/yy
    // operated on the literal ::: line. A directive open must end the paragraph like FencedCode.
    const src = "top\n:::table\n<table></table>\n:::\nbot\n";
    const ns = nodes(src);
    expect(ns.some((n) => n.startsWith("Directive["))).toBe(true);
    const para = ns.find((n) => n.startsWith("Paragraph["));
    expect(para).toBeDefined();
    // the paragraph is just "top" (ends before the directive), not "top\n:::table…"
    const [, , pTo] = /Paragraph\[(\d+),(\d+)\]/.exec(para!)!;
    expect(Number(pTo)).toBe(3); // "top" only
  });

  it("a labeled open line is a Directive with NO Link node — the label's [..] is not linkified (#94)", () => {
    // The whole open line is consumed as a DirectiveMark, so its `[..]` is never inline-parsed.
    for (const src of [":::callout[My Note]\nbody\n:::\n", ":::callout[a]b]\nbody\n:::\n", ":::warning[サーバ停止のお知らせ]\nbody\n:::\n"]) {
      const ns = nodes(src);
      expect(ns.some((n) => n.startsWith("Directive["))).toBe(true);
      expect(ns.some((n) => n.startsWith("Link["))).toBe(false); // no link decoration source
    }
  });
});


// #185 / ADR-096 (Option B): the pure stack resolver is the single source of truth for `:::` nesting.
// A close pops the INNERMOST open directive (Pandoc semantics); colon count never gates the close, so a
// deep `::::columns` close no longer early-closes its `:::tabs` parent (the bug the CSS/margin fixes
// couldn't touch). These lock the nesting the reviewer's dense repro exercises.
describe("resolveDirectiveRanges (stack-based nesting)", () => {
  const byName = (rs: ReturnType<typeof resolveDirectiveRanges>, n: string) => rs.filter((r) => r.name === n);

  it("resolves a simple directive", () => {
    const src = ":::note\nhi\n:::";
    const rs = resolveDirectiveRanges(src);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ name: "note", depth: 0, closed: true, from: 0 });
    expect(rs[0]!.to).toBe(src.length);
  });

  it("does NOT let an inner ::::columns close its :::tabs parent (early-close bug)", () => {
    // outer tabs(4) with an inner columns(4) whose close `::::` previously closed the parent tabs early.
    const src = [
      "::::tabs",          // 0
      ":::tab[Tab 1]",     // 1
      "::::columns",       // 2
      ":::column",         // 3
      "warning",           // 4
      ":::",               // 5  closes :::column
      "::::",              // 6  closes ::::columns
      ":::",               // 7  closes :::tab
      ":::tab[Tab 2]",     // 8
      "second",            // 9
      ":::",               // 10 closes :::tab (Tab 2)
      "::::",              // 11 closes ::::tabs
    ].join("\n");
    const rs = resolveDirectiveRanges(src);
    const tabs = byName(rs, "tabs");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.depth).toBe(0);
    expect(tabs[0]!.closed).toBe(true);
    // the tabs directive spans the WHOLE thing — it is NOT truncated at the inner columns close.
    expect(tabs[0]!.from).toBe(0);
    expect(tabs[0]!.to).toBe(src.length);
    // BOTH tabs are inside (not one orphaned outside) and columns/column nest correctly.
    expect(byName(rs, "tab")).toHaveLength(2);
    expect(byName(rs, "columns")).toHaveLength(1);
    expect(byName(rs, "column")).toHaveLength(1);
    // no raw marker leaks: every closing `:::` was consumed by a directive on the stack.
    expect(byName(rs, "tab")[0]!.depth).toBe(1);
    expect(byName(rs, "columns")[0]!.depth).toBe(2);
    expect(byName(rs, "column")[0]!.depth).toBe(3);
  });

  it("closes the innermost even for SAME colon count at two levels (Pandoc)", () => {
    const src = ":::a\n:::b\ntext\n:::\n:::";
    const rs = resolveDirectiveRanges(src);
    expect(byName(rs, "a")[0]).toMatchObject({ depth: 0 });
    expect(byName(rs, "b")[0]).toMatchObject({ depth: 1 });
    expect(byName(rs, "a")[0]!.to).toBe(src.length); // a spans both
    expect(byName(rs, "b")[0]!.to).toBeLessThan(src.length); // b closes first (inner)
  });

  it("an unclosed directive runs to EOF (reveal-on-cursor while editing)", () => {
    const rs = resolveDirectiveRanges(":::note\nstill typing");
    expect(rs[0]).toMatchObject({ name: "note", closed: false });
    expect(rs[0]!.to).toBe(":::note\nstill typing".length);
  });
});

// #393 / ADR-151 §0: the shared directive-ATTRIBUTE facility ({key=val} after the optional [label]).
describe("directive attributes (#393 / ADR-151)", () => {
  it("parses bare and quoted values; unknown keys preserved verbatim", () => {
    expect(parseDirectiveOpen(":::table{align=left}")).toEqual({ colons: 3, name: "table", attrs: { align: "left" } });
    expect(parseDirectiveOpen(':::table{align=right foo="two words"}')).toEqual({ colons: 3, name: "table", attrs: { align: "right", foo: "two words" } });
    expect(parseDirectiveOpen(":::table{}")).toEqual({ colons: 3, name: "table" }); // empty braces → no attrs field
    expect(parseDirectiveOpen(":::table")).toEqual({ colons: 3, name: "table" }); // absent → unchanged shape
  });
  it("serializeDirectiveAttrs round-trips what parseDirectiveAttrs read (order-stable, lossless)", () => {
    const attrs = parseDirectiveOpen(':::table{align=left keep="a b"}')!.attrs!;
    expect(serializeDirectiveAttrs(attrs)).toBe('{align=left keep="a b"}');
    expect(serializeDirectiveAttrs(undefined)).toBe("");
    expect(serializeDirectiveAttrs({})).toBe("");
  });
  it("resolveDirectiveRanges carries attrs on the resolved range", () => {
    const r = resolveDirectiveRanges(":::table{align=right}\n<table></table>\n:::\n");
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe("table");
    expect(r[0]!.attrs).toEqual({ align: "right" });
  });
});
