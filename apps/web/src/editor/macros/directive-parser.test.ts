import { describe, it, expect } from "vitest";
import { parser } from "@lezer/markdown";
import { directiveExtension, parseDirectiveOpen, isDirectiveClose } from "./directive-parser";

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
    expect(parseDirectiveOpen(":::note{type=warn}")).toEqual({ colons: 3, name: "note" });
    expect(parseDirectiveOpen("::::columns")).toEqual({ colons: 4, name: "columns" });
    expect(parseDirectiveOpen(":::")).toBeNull(); // no name → not an opening
    expect(parseDirectiveOpen("text")).toBeNull();
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
});
