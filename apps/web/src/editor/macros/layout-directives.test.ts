import { describe, it, expect } from "vitest";
import { parseLayoutItems, tabsMacro, columnsMacro } from "./layout-directives";

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

// #90 (approved: Open-formats degradation must PRESERVE MEANING). A plain reader / static export has
// no tab or column widget, so htmlRender must degrade so the information survives.
describe("layout directive degradation (#90 htmlRender, meaning-preserving)", () => {
  it("tabs degrade to a VISIBLE heading (label) + body per tab — the label is not lost", () => {
    const out = tabsMacro.htmlRender(":::tab[Setup]\nstep one\n:::\n:::tab[Usage]\nrun it\n:::").toString();
    // Each tab's label becomes an <h3> heading a non-tab reader can see (was: a hidden data-label attr).
    expect(out).toContain("<h3 class=\"tab-label\">Setup</h3>");
    expect(out).toContain("<h3 class=\"tab-label\">Usage</h3>");
    expect(out).toContain("step one"); // body content preserved
    expect(out).toContain("run it");
    expect(out).not.toContain("data-label"); // the label is a heading now, not a hidden attribute
  });

  it("tabs without a label fall back to a numbered heading (still visible, not empty)", () => {
    const out = tabsMacro.htmlRender(":::tab\na\n:::\n:::tab\nb\n:::").toString();
    expect(out).toContain("<h3 class=\"tab-label\">Tab 1</h3>");
    expect(out).toContain("<h3 class=\"tab-label\">Tab 2</h3>");
  });

  it("columns degrade to each column's content in order (sequential — nothing dropped)", () => {
    const out = columnsMacro.htmlRender(":::column\nleft\n:::\n:::column\nright\n:::").toString();
    // The columns stack (no CSS grid in a plain reader) but every column's content is present and ordered.
    expect(out.indexOf("left")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("right")).toBeGreaterThan(out.indexOf("left"));
  });

  it("degradation escapes the label (XSS-safe) — a malicious tab label cannot inject markup", () => {
    const out = tabsMacro.htmlRender(":::tab[<img src=x onerror=alert(1)>]\nx\n:::").toString();
    expect(out).not.toContain("<img src=x"); // escaped, not live markup
    expect(out).toContain("&lt;img"); // present as escaped text
  });
});
