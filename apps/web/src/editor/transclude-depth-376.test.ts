// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { renderMarkdownToDom } from "./macros/md-render";
import "./macros"; // register embed-page etc.

// #376 / ADR-149 (approval condition 2): the transclude depth/cycle guard on the PUBLIC mount is
// CLIENT-STRUCTURAL, and this pins the structure: a transcluded page's CONTENT renders through
// renderMarkdownToDom, whose `:::embed-page` dispatch is the registry liveRender — a static
// placeholder that NEVER fetches (the fetch lives only in the top-level CM widget path, gated by the
// transcludeResolver facet). So depth is bounded at ONE hop by construction: a cycle (A embeds B, B
// embeds A) cannot recurse or amplify requests on any surface, the anonymous public reader included.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => { throw new Error("a nested embed must NEVER fetch"); }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("nested transclusion is structurally depth-1 (#376 condition 2)", () => {
  it("an :::embed-page inside TRANSCLUDED content renders the static placeholder — zero fetches", () => {
    // This is exactly what the transclude widget does with resolved content: renderMarkdownToDom(content).
    const transcludedContent = "outer text\n\n:::embed-page\nsome-other-page-id\n:::\n\ntail";
    const d = document.createElement("div");
    d.appendChild(renderMarkdownToDom(transcludedContent)); // poisoned fetch throws if anything fetches
    const embed = d.querySelector("[data-testid=macro-embed-page]");
    expect(embed, "the nested embed renders as the registry placeholder").not.toBeNull();
    expect(embed!.textContent).toBe("…"); // the static marker — content is never resolved at depth ≥ 1
    expect(d.textContent).toContain("outer text");
    expect(d.textContent).toContain("tail");
  });

  it("a self-cycle shape (content embedding its own id) renders the same inert placeholder", () => {
    const selfId = "self-cycle-page";
    const content = `:::embed-page\n${selfId}\n:::`;
    const d = document.createElement("div");
    d.appendChild(renderMarkdownToDom(content));
    expect(d.querySelector("[data-testid=macro-embed-page]")?.textContent).toBe("…");
  });
});
