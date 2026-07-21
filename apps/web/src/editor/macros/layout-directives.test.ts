import { describe, it, expect } from "vitest";
import { parseLayoutItems, tabsMacro, columnsMacro, tabsEnterTarget, setActiveTabIndex } from "./layout-directives";
import { asMacroSource } from "./registry";

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

// #456 S2: a container declares where Ctrl+↵ lands (the S1 `enter` contract) instead of the host
// hardcoding it. The offsets are relative to the macro's own source, so the host maps them to the
// document without the macro doing coordinate work — these pin that the ranges really are the slot
// bodies, which is the part a wrong answer would silently get away with.
describe("#456 S2: container enter targets", () => {
  const COLUMNS = "::::columns\n:::column\nfirst body\n:::\n:::column\nsecond body\n:::\n::::";
  const TABS = "::::tabs\n:::tab[One]\ntab one body\n:::\n:::tab[Two]\ntab two body\n:::\n::::";

  it("columns enters the FIRST column, and the range is exactly that column's body", () => {
    const t = columnsMacro.enter!(asMacroSource(COLUMNS))!;
    expect(t).not.toBeNull();
    expect(COLUMNS.slice(t.from, t.to)).toBe("first body");
  });

  it("tabs enters the active tab — the first one when nothing has been activated", () => {
    const t = tabsMacro.enter!(asMacroSource(TABS))!;
    expect(TABS.slice(t.from, t.to)).toBe("tab one body");
  });

  it("tabs follows the tab the reader is actually on", () => {
    const base = 4242;
    setActiveTabIndex(base, 1);
    const t = tabsEnterTarget(TABS, base)!;
    expect(TABS.slice(t.from, t.to), "the SECOND tab, because that is what is on screen").toBe("tab two body");
  });

  it("an out-of-range remembered tab clamps rather than returning nothing", () => {
    const base = 4243;
    setActiveTabIndex(base, 99); // e.g. tabs were deleted since
    const t = tabsEnterTarget(TABS, base)!;
    expect(TABS.slice(t.from, t.to)).toBe("tab two body");
  });

  it("a container with no slots has no entry — the host falls back to the normal editUI", () => {
    expect(columnsMacro.enter!(asMacroSource("::::columns\n::::"))).toBeNull();
  });
});
