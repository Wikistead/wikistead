// @vitest-environment happy-dom
// #611 / ADR-211: the structural link judge, pinned pure (state in, ranges out — the tree assertions
// live HERE, not in e2e, because no dev probe exposes the syntax tree in a browser).
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";
import { linkAt, linksTouching, linkLabel, linkUrl } from "./link-at";
import { unlink } from "./commands";
import { EditorView } from "@codemirror/view";

const state = (doc: string) => {
  const s = EditorState.create({ doc, extensions: [markdown()] });
  ensureSyntaxTree(s, doc.length, 5000);
  return s;
};

describe("#611: linkAt finds what an ancestor walk cannot", () => {
  it("a paragraph-wide selection finds the link inside it (the iterate pin — the main nesting path)", () => {
    const doc = "aa [foo](http://x) bb";
    const s = state(doc);
    const hit = linkAt(s, 0, doc.length);
    expect(hit, "review-measured: both endpoints resolve OUTSIDE the Link; only iterate sees it").not.toBeNull();
    expect(linkLabel(s, hit!)).toBe("foo");
    expect(linkUrl(s, hit!)).toBe("http://x");
  });

  it("a cursor touching either EDGE counts as inside (the boundary-side convention, pinned)", () => {
    const doc = "x [a](http://u) y";
    const s = state(doc);
    const from = doc.indexOf("["), to = doc.indexOf(")") + 1;
    expect(linkAt(s, from, from), "left edge").not.toBeNull();
    expect(linkAt(s, to, to), "right edge").not.toBeNull();
    expect(linkAt(s, 0, 0), "well outside").toBeNull();
  });

  it("overlap resolves to the FIRST touched link; a second link is untouched (ADR §3)", () => {
    const doc = "[a](http://1) mid [b](http://2)";
    const s = state(doc);
    const hits = linksTouching(s, 0, doc.length);
    expect(hits).toHaveLength(2);
    expect(linkUrl(s, linkAt(s, 5, doc.length)!), "straddling both answers the first touched").toBe("http://1");
  });
});

describe("#611 ADR §5: the scope table's no-rows answer as not-a-link (never a silent half-rewrite)", () => {
  it("autolink, bare URL and image are NOT hits", () => {
    for (const doc of ["see <http://x> here", "see http://x here", "an ![alt](http://img) here"]) {
      expect(linkAt(state(doc), 0, doc.length), doc).toBeNull();
    }
  });

  it("a reference link IS a hit but has no URL (dialog-editing is refused upstream; unlink still works)", () => {
    const doc = "see [a][ref] here\n\n[ref]: http://x\n";
    const s = state(doc);
    const hit = linkAt(s, 4, 12);
    expect(hit).not.toBeNull();
    expect(hit!.hasUrl).toBe(false);
    expect(linkUrl(s, hit!)).toBe("");
  });
});

describe("#611: unlink leaves the label and nothing else", () => {
  const runUnlink = (doc: string, selFrom: number, selTo: number) => {
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown()] }) });
    ensureSyntaxTree(view.state, doc.length, 5000);
    view.dispatch({ selection: { anchor: selFrom, head: selTo } });
    unlink(view);
    const out = view.state.doc.toString();
    ensureSyntaxTree(view.state, out.length, 5000);
    let links = 0;
    syntaxTree(view.state).iterate({ enter: (n) => { if (n.name === "Link") links++; } });
    view.destroy();
    return { out, links };
  };

  it("full node from a cursor inside: label survives, zero Link nodes, zero shrapnel", () => {
    const doc = "aa [foo](http://x) bb";
    const r = runUnlink(doc, doc.indexOf("foo") + 1, doc.indexOf("foo") + 1);
    expect(r.out).toBe("aa foo bb");
    expect(r.links).toBe(0);
    expect(r.out.includes("](")).toBe(false);
  });

  it("a PARTIAL selection cannot leave `](url)` shrapnel — the node, not the selection, is replaced", () => {
    const doc = "aa [foo bar](http://x) bb";
    const r = runUnlink(doc, doc.indexOf("foo"), doc.indexOf("foo") + 2); // 2 chars inside the label
    expect(r.out).toBe("aa foo bar bb");
    expect(r.links).toBe(0);
    expect(r.out.includes("](")).toBe(false);
  });

  it("away from any link it does nothing (and the no-row forms are untouched)", () => {
    for (const doc of ["plain text", "see <http://x> here", "an ![alt](http://img) here"]) {
      const r = runUnlink(doc, 0, doc.length);
      expect(r.out, doc).toBe(doc);
    }
  });
});

describe("#611: the nesting scan — no Link inside a Link label, after the paste retarget shape", () => {
  it("the document invariant the guard preserves is expressible and starts true", () => {
    const doc = "x [a](http://1) y";
    const s = state(doc);
    let nested = 0;
    syntaxTree(s).iterate({ enter: (n) => {
      if (n.name !== "Link") return;
      let inner = 0;
      syntaxTree(s).iterate({ from: n.from + 1, to: n.to - 1, enter: (m) => { if (m.name === "Link" && (m.from !== n.from || m.to !== n.to)) inner++; } });
      nested += inner;
    } });
    expect(nested).toBe(0);
  });
});
