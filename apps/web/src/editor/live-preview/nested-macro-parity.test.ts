// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdownExtension } from "../markdown-config";
import { innermostMacroAt, nestedDeleteChange, resolveNestedAnchor } from "./decorations";
import { renderMarkdownToDom, setPendingBaseOffset, takePendingBaseOffset } from "../macros/md-render";
import { columnsLiveRender } from "../macros/layout-directives";
import { parseLayoutItems, resolveDirectiveRanges } from "@wikistead/macro-render";
import "../macros"; // register columns / callouts / table so the resolver + liveRender see them

// #215 / ADR-100 (nested-macro parity): a macro is a macro at any depth. All four consumers key off ONE
// question — innermostMacroAt(anchor) — so a click selects exactly what the edit button opens and
// Backspace/dd/Delete removes. These assert the PURE resolver + the source-anchor tagging (the parts a
// real browser doesn't need to exercise); the layout/edit/motion behaviour is covered by the e2e spec.

const mk = (doc: string) => EditorState.create({ doc, selection: EditorSelection.cursor(0), extensions: [markdownExtension()] });

// intro + a columns block: left column holds a nested :::note, right column holds plain text + a :::table.
const DOC = [
  "intro",
  "",
  "::::columns",
  ":::column",
  ":::note",
  "AAA note",
  ":::",
  ":::",
  ":::column",
  "BBB text",
  "::::",
  "",
  "tail",
  "",
].join("\n");

// The absolute offset of the columns INNER body (the first line after `::::columns`).
const bodyFrom = DOC.indexOf(":::column");
const innerBody = DOC.slice(bodyFrom, DOC.indexOf("\n::::\n")); // the columns body passed to the liveRender

describe("parseLayoutItems contentOffset (#215 source anchor)", () => {
  it("points at the first content byte of each item (drift-free)", () => {
    const items = parseLayoutItems(innerBody, "column");
    expect(items).toHaveLength(2);
    // column 1's content begins at `:::note`; contentOffset is relative to innerBody
    expect(innerBody.slice(items[0]!.contentOffset)).toMatch(/^:::note/);
    expect(innerBody.slice(items[1]!.contentOffset)).toMatch(/^BBB text/);
  });
});

describe("innermostMacroAt (#215 one resolver, four consumers)", () => {
  it("resolves a nested callout anchor to the callout's range, not the container", () => {
    const state = mk(DOC);
    const noteFrom = DOC.indexOf(":::note");
    const m = innermostMacroAt(state, noteFrom);
    expect(m?.name).toBe("note");
    expect(m?.from).toBe(noteFrom);
    // the container columns starts earlier — we did NOT resolve to it
    expect(m!.from).toBeGreaterThan(DOC.indexOf("::::columns"));
  });

  it("resolves a nested :::table anchor to the table, and matches the top-level table result (parity)", () => {
    const nested = mk("::::columns\n:::column\n:::table\n<table><tr><td>x</td></tr></table>\n:::\n:::\n::::");
    const top = mk(":::table\n<table><tr><td>x</td></tr></table>\n:::");
    const nm = innermostMacroAt(nested, nested.doc.toString().indexOf(":::table"));
    const tm = innermostMacroAt(top, top.doc.toString().indexOf(":::table"));
    expect(nm?.name).toBe("table");
    expect(tm?.name).toBe("table");
    // identical inner shape (both span their own :::table block) — no depth-dependent divergence
    expect(nm!.to - nm!.from).toBe(tm!.to - tm!.from);
  });
});

describe("nestedDeleteChange (#215 Consumer 4 — one range, three keys)", () => {
  it("removes only the nested callout's lines; container + sibling column stay intact", () => {
    const state = mk(DOC);
    const noteFrom = DOC.indexOf(":::note");
    const ch = nestedDeleteChange(state, noteFrom)!;
    expect(ch).toBeTruthy();
    const next = state.doc.sliceString(0, ch.from) + state.doc.sliceString(ch.to);
    // the note is gone, the container fences + the sibling column survive
    expect(next).not.toContain("AAA note");
    expect(next).toContain("::::columns");
    expect(next).toContain("BBB text");
    // the columns container + both columns still resolve (balanced fences)
    const ranges = resolveDirectiveRanges(next);
    expect(ranges.some((r) => r.name === "columns")).toBe(true);
    expect(ranges.filter((r) => r.name === "column")).toHaveLength(2);
    expect(ranges.some((r) => r.name === "note")).toBe(false);
  });

  it("returns the same range whether reached by Backspace, Delete, or dd (they share this function)", () => {
    const state = mk(DOC);
    const anchor = DOC.indexOf(":::note");
    const a = nestedDeleteChange(state, anchor);
    const b = nestedDeleteChange(state, anchor);
    expect(a).toEqual(b); // pure → the three key paths converge by construction
  });
});

describe("source-anchor tagging (#215 hit-test wiring)", () => {
  it("tags the nested callout with data-mac-pos = its absolute from; the tag re-resolves to that macro", () => {
    const state = mk(DOC);
    setPendingBaseOffset(bodyFrom);
    const dom = columnsLiveRender(innerBody);
    const tagged = dom.querySelector("[data-mac-pos]") as HTMLElement;
    expect(tagged).toBeTruthy();
    const anchor = Number(tagged.dataset.macPos);
    // the tag lands exactly on the note's source range and re-resolves to the note
    expect(anchor).toBe(DOC.indexOf(":::note"));
    expect(innermostMacroAt(state, anchor)?.name).toBe("note");
    // resolveNestedAnchor reads the innermost tagged ancestor from a click target (input-independent)
    expect(resolveNestedAnchor(tagged)).toBe(anchor);
  });

  it("is INERT without a base (all existing callers): no data-mac-pos, byte-identical output", () => {
    // no setPendingBaseOffset → takePendingBaseOffset() is null → untagged
    expect(takePendingBaseOffset()).toBeNull();
    const dom = columnsLiveRender(innerBody);
    expect(dom.querySelector("[data-mac-pos]")).toBeNull();
    const plain = renderMarkdownToDom(":::note\nhi\n:::");
    expect((plain.firstChild as HTMLElement | null)?.dataset?.macPos).toBeUndefined();
  });
});
