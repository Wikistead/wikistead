// #381 / ADR-163 §3: the resolver-set facade's CLOSED sets — the anti-drift pins. `public` is exactly
// the ADR-149 anonymous trio (and never the attachment resolver); template/preview never gain
// transclude/attachment. A drift here is the #376 bug class (a surface mounting with wrong resolvers).
import { describe, it, expect } from "vitest";
import { makeResolverSet } from "./resolver-set";

const keys = (o: object) => Object.keys(o).sort();

describe("makeResolverSet", () => {
  it("page (member/guest): the full resource set; diagram/transclude only with a pageId", () => {
    expect(keys(makeResolverSet({ kind: "page", token: "t", pageId: "p1" })))
      .toEqual(["renderDiagram", "resolveAttachment", "resolveImageUrl", "resolveTransclude"]);
    expect(keys(makeResolverSet({ kind: "page", token: "t", pageId: null })))
      .toEqual(["resolveAttachment", "resolveImageUrl"]);
  });

  it("template: image + template diagram ONLY (no transclude, no attachment)", () => {
    expect(keys(makeResolverSet({ kind: "template", token: "t", templateId: "tpl" })))
      .toEqual(["renderDiagram", "resolveImageUrl"]);
  });

  it("preview (search hit / embed picker): image + diagram ONLY", () => {
    expect(keys(makeResolverSet({ kind: "preview", token: "t", pageId: "p1" })))
      .toEqual(["renderDiagram", "resolveImageUrl"]);
  });

  it("public: EXACTLY the ADR-149 anonymous trio — image + diagram + transclude, never attachment", () => {
    const set = makeResolverSet({ kind: "public", pageId: "p1" });
    expect(keys(set)).toEqual(["renderDiagram", "resolveImageUrl", "resolveTransclude"]);
    expect("resolveAttachment" in set).toBe(false);
  });
});
