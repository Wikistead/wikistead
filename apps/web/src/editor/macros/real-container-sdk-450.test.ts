// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import "./index"; // register the first-party macros — a bare import graph has none, and a probe that
                  // forgets this reports "no nested macro" for a reason that has nothing to do with the code
import { columnsMacro, tabsMacro } from "./layout-directives";
import { dispatchMacroRender } from "./md-render";

// #450 slice 5b, follow-up. The slice's own tests dispatched a STUB that declared
// `capabilities: ["theme", "render-markdown"]`, so they proved the SDK works for a macro that declares —
// and said nothing about the macros that actually ship. None of the first-party containers declares
// anything, and with the default narrowed to `["theme"]` they stopped receiving `renderMarkdown`, fell
// back to an untagged render, and every nested macro lost its `data-mac-pos` — the #215 hit-test data
// that nested selection, the nested ✎ and the slot island all resolve through.
//
// Measured both ways: with the default at `["theme"]` this file fails; with the brokered vocabulary it
// passes. That is why the default is what it is, and this is the test that says so with the REAL macro.
const tagged = (el: HTMLElement) => el.querySelector("[data-mac-pos]");

describe("#450: the containers that actually ship still tag what they nest", () => {
  it("columns tags a nested macro with its absolute position", () => {
    const body = ":::column\n:::note\nhi\n:::\n:::";
    const el = dispatchMacroRender(columnsMacro as never, body, { theme: {} as never, baseOffset: 100 })!;
    const t = tagged(el);
    expect(t, "a nested macro inside a real :::columns is hit-testable").toBeTruthy();
    expect(Number(t!.getAttribute("data-mac-pos")), "and its anchor is the host's arithmetic").toBeGreaterThan(100);
  });

  it("tabs does too", () => {
    const body = ":::tab[One]\n:::note\nhi\n:::\n:::";
    const el = dispatchMacroRender(tabsMacro as never, body, { theme: {} as never, baseOffset: 200 })!;
    expect(tagged(el), "a nested macro inside a real :::tabs is hit-testable").toBeTruthy();
  });

  it("an UNDECLARED macro receives the brokered vocabulary — that is what shipping macros rely on", () => {
    let caps: string[] = [];
    dispatchMacroRender(
      { liveRender: (_b: never, ctx: { capabilities?: string[] }) => { caps = [...(ctx.capabilities ?? [])]; return document.createElement("div"); } } as never,
      "x", { theme: {} as never },
    );
    expect(caps.sort()).toEqual(["design-tokens", "host-list", "render-markdown", "theme"]);
  });
});
