import { describe, it, expect } from "vitest";
import { parseLayoutItems } from "./layout-directives";

describe("parseLayoutItems (#90)", () => {
  it("splits the inner items by name and keeps content", () => {
    const items = parseLayoutItems(":::column\nA text\n:::\n:::column\nB text\n:::", "column");
    expect(items).toHaveLength(2);
    expect(items[0]!.content).toBe("A text");
    expect(items[1]!.content).toBe("B text");
  });

  it("a nested directive inside an item does NOT prematurely close it (depth-tracking)", () => {
    const body = ":::column\n:::note\nhi\n:::\nafter\n:::"; // a column containing a callout, then more text
    const items = parseLayoutItems(body, "column");
    expect(items).toHaveLength(1);
    expect(items[0]!.content).toContain(":::note");
    expect(items[0]!.content).toContain("after"); // not cut off by the inner close
  });

  it("captures the optional [label]", () => {
    expect(parseLayoutItems(":::tab[First]\nx\n:::", "tab")[0]!.label).toBe("First");
  });

  it("ignores top-level lines that aren't the named item", () => {
    expect(parseLayoutItems("stray\n:::column\nx\n:::", "column")).toHaveLength(1);
  });
});
