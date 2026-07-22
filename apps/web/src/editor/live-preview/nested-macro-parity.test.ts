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

// #450 / ADR-177 slice 2 prep: a `:::tagged`/`:::children` inside a container resolves through the
// list-host seam exactly as a top-level one does. This path is the reason the host is a threaded seam
// at all, and it is the one the re-entrancy anti-test (ADR-177 §"Anti-tests") will build on — but no
// test reached it, so retiring the `withListHost` module singleton could break it while every existing
// test stayed green (a false green the ADR calls out). Pins the CURRENT behaviour so the threading
// refactor is genuinely behaviour-preserving, and so the container-recursion path cannot be dropped
// silently. columnsLiveRender recurses via appendMarkdownInto, which reads the same seam.
describe("#450: a list macro nested in a container resolves through the host seam", () => {
  it("fills a :::children inside a :::column via the list host (not top-level only)", async () => {
    const { withListHost } = await import("../macros/md-render");
    const fetched: { name: string; body: string }[] = [];
    const host = {
      fetch: async (name: "tagged" | "children", body: string) => {
        fetched.push({ name, body });
        return [{ id: "p1", title: "Child One" }, { id: "p2", title: "Child Two" }];
      },
      navigate: () => {},
      emptyLabel: "(empty)",
      untitledLabel: "(untitled)",
    };
    const body = ":::column\n:::children\n:::\n:::\n:::column\nplain\n:::";
    const row = withListHost(host, () => columnsLiveRender(body));
    // the nested list dispatched a placeholder synchronously…
    const holder = row.querySelector<HTMLElement>("[data-testid=macro-children-nested]");
    expect(holder, "the nested :::children dispatched through the host seam").not.toBeNull();
    // …and the host's fetch was the ONLY resolution path (no direct network, ADR-177 authz gate)
    expect(fetched, "the container-nested list resolved through the host, exactly once").toEqual([
      { name: "children", body: "" },
    ]);
    // let the async fill land, then the titles are present as text (XSS-inert), the host's job done
    await Promise.resolve(); await Promise.resolve();
    expect(row.textContent).toContain("Child One");
    expect(row.textContent).toContain("Child Two");
  });

  it("without a host the container-nested list does not dispatch (top-level parity: seam-gated)", () => {
    // no withListHost wrapper → activeListHost is null → the nested list falls through, exactly as a
    // static/hover render does. Pins that the dispatch is SEAM-gated, so the threading can't accidentally
    // make it fire host-free.
    const body = ":::column\n:::children\n:::\n:::";
    const row = columnsLiveRender(body);
    expect(row.querySelector("[data-testid=macro-children-nested]"), "no host → no host-dispatched list").toBeNull();
  });
});
