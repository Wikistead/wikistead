import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "../markdown-config";
import { collectInternalLinks, planLinkStatusRequest, LINK_STATUS_REQUEST_CAP } from "./dead-links";

// #276 / ADR-117: the dead-link overlay collects its `/p/<id>` targets from the SAME Lezer Link nodes +
// linkHref sanitizer as the cm-lp-link mark, so overlay and link body never disagree. These pin the
// collection: internal `/p/<id>` links only — external URLs, attachment links, and non-links are excluded.
const mk = (doc: string) => EditorState.create({ doc, extensions: [markdownExtension()] });
const ids = (doc: string) => collectInternalLinks(mk(doc)).map((l) => l.id);

describe("collectInternalLinks (#276 / ADR-117)", () => {
  it("collects the id of an internal /p/<id> link", () => {
    const doc = "see [the target](/p/abc-123) here";
    const found = collectInternalLinks(mk(doc));
    expect(found.map((l) => l.id)).toEqual(["abc-123"]);
    // the range spans the whole Link node (so the dead mark layers over the same span as cm-lp-link)
    expect(doc.slice(found[0]!.from, found[0]!.to)).toBe("[the target](/p/abc-123)");
  });

  it("collects multiple internal links and strips any query/hash from the id", () => {
    expect(ids("[a](/p/one) and [b](/p/two?x=1) and [c](/p/three#frag)")).toEqual(["one", "two", "three"]);
  });

  it("excludes EXTERNAL links (http/https/mailto) — external liveness is out of scope", () => {
    expect(ids("[x](https://example.com/p/notapage) [y](mailto:a@b.c) [z](http://p/nope)")).toEqual([]);
  });

  it("excludes attachment links and other non-/p paths", () => {
    expect(ids("[file](wks-attachment:xyz) [home](/) [rel](/other/abc)")).toEqual([]);
  });

  it("ignores plain text that merely looks like a path (no Link node)", () => {
    expect(ids("just text /p/abc not a link")).toEqual([]);
  });
});

// #755 / ADR-241 decision 2: the request is scoped to what the reader can see, and it is capped.
//
// `page#view` is the one relation that unions the whole capability lattice, and it costs the store many
// times what the other page relations do (measured on this ticket). Opening a page used to buy an answer
// for every internal link in the document at once — including the ones a thousand lines down that nobody
// had looked at. The ANSWERS do not change; when they are asked does.
describe("#755: the fetch asks about the visible part of the document", () => {
  const link = (id: string) => `see [target](/p/${id})`;
  // Three links, one per line, at known offsets.
  const doc = [link("first"), link("second"), link("third")].join("\n");
  const state = mk(doc);
  const lineRange = (n: number) => {
    const line = state.doc.line(n);
    return { from: line.from, to: line.to };
  };

  it("a range collects only the links inside it", () => {
    expect(collectInternalLinks(state, [lineRange(2)]).map((l) => l.id)).toEqual(["second"]);
  });

  it("several ranges collect their union, in document order", () => {
    expect(collectInternalLinks(state, [lineRange(1), lineRange(3)]).map((l) => l.id)).toEqual(["first", "third"]);
  });

  it("no ranges at all still means the whole document — the decoration build depends on it", () => {
    // The overload has two callers with opposite needs, and swapping them would be silent: the fetch
    // would go back to asking about everything, and every test above would still pass.
    expect(collectInternalLinks(state).map((l) => l.id)).toEqual(["first", "second", "third"]);
  });

  it("a link straddling two ranges is collected once, not twice", () => {
    // CodeMirror hands out a viewport as several ranges, and a node overlapping both is entered by each.
    // A duplicate id in the request is harmless; a duplicate here would mean the de-dup is doing work the
    // collector should have done, and the count is what a reader of the batch size would trust.
    const one = mk(link("straddler"));
    const mid = Math.floor(one.doc.length / 2);
    const found = collectInternalLinks(one, [{ from: 0, to: mid }, { from: mid, to: one.doc.length }]);
    expect(found.map((l) => l.id)).toEqual(["straddler"]);
  });
});

describe("#755: planning the request", () => {
  const cands = (...ids: string[]) => ids.map((id) => ({ id }));
  const none = new Map<string, boolean>();
  const nothingPending = new Set<string>();

  it("asks only about ids with no answer yet and none in flight", () => {
    const known = new Map([["answered", true], ["also-answered", false]]);
    const pending = new Set(["in-flight"]);
    expect(planLinkStatusRequest(cands("answered", "in-flight", "new", "also-answered"), known, pending, 256))
      .toEqual(["new"]);
  });

  it("asks about a repeated link once", () => {
    expect(planLinkStatusRequest(cands("same", "same", "same"), none, nothingPending, 256)).toEqual(["same"]);
  });

  it("NEVER exceeds the cap — the route trims a longer list in silence, and absence reads as dead", () => {
    // The bug this replaced: the client sent every link it found, the route trimmed the list to its cap
    // and answered 200 without saying it had trimmed, and the caller recorded every id it had SENT as
    // answered. Ids past the cap came back absent — which is how this overlay spells "dead" — so a
    // document with more internal links than the cap wore a strike-through on the ones past it, every one
    // of them alive. Nothing in the response could have told the client otherwise: absent is absent.
    const many = cands(...Array.from({ length: 400 }, (_, i) => `p${i}`));
    const batch = planLinkStatusRequest(many, none, nothingPending, LINK_STATUS_REQUEST_CAP);
    expect(batch).toHaveLength(LINK_STATUS_REQUEST_CAP);
    expect(batch[0]).toBe("p0"); // …and it keeps document order, so the reader's screenful goes first
  });

  it("the ids left over are simply asked next time — nothing is dropped on the floor", () => {
    const many = cands(...Array.from({ length: 300 }, (_, i) => `p${i}`));
    const first = planLinkStatusRequest(many, none, nothingPending, LINK_STATUS_REQUEST_CAP);
    const answered = new Map(first.map((id) => [id, true] as const));
    const second = planLinkStatusRequest(many, answered, nothingPending, LINK_STATUS_REQUEST_CAP);
    expect(second).toHaveLength(300 - LINK_STATUS_REQUEST_CAP);
    expect(new Set([...first, ...second]).size, "some id was never asked about").toBe(300);
  });
});
