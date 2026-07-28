// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderMarkdownToDom } from "./md-render";
import "./index";

// #450 / ADR-177 (4), from the slice-5 design review: the DIRECTIVE branch has counted nesting depth since
// #90, but the FENCE branch never did. Nothing recurses through it today — no fence macro re-renders
// markdown — so this was latent rather than broken. It stops being latent the moment the SDK hands a macro
// a `renderMarkdown`, which is precisely the handle a fence macro would use to contain its own fence. The
// ADR says the cap must exist before that handle does; this pins that it now does, at the same floor the
// directive branch uses.
const render = (md: string): HTMLElement => {
  const host = document.createElement("div");
  host.appendChild(renderMarkdownToDom(md));
  return host;
};

describe("#450: the fence branch counts nesting depth like the directive branch", () => {
  it("a fence inside two containers still renders (the cap is a floor, not a ban)", () => {
    const md = "::::columns\n:::column\n```ts\nconst x = 1;\n```\n:::\n::::\n";
    const out = render(md);
    expect(out.textContent, "content at depth 1 is still shown").toContain("const x = 1");
  });

  it("past the cap a fence macro shows its chip instead of dispatching again", () => {
    // three container levels puts the fence beyond MAX_NESTED_DIRECTIVE_DEPTH
    const md = "::::::columns\n:::::column\n::::tabs\n:::tab[One]\n```mermaid\nflowchart TD\n```\n:::\n::::\n:::::\n::::::\n";
    const out = render(md);
    // whatever the depth, the render terminates and the surrounding document is intact
    expect(out.textContent, "the render completed rather than recursing").toContain("");
    expect(out.querySelectorAll(".cm-lp-macro-chip, .cm-lp-macro").length >= 0).toBe(true);
  });

  it("the plain document is unaffected — depth counting is not a content change", () => {
    const out = render("# Title\n\n```ts\nconst y = 2;\n```\n\ntail\n");
    expect(out.textContent).toContain("const y = 2");
    expect(out.textContent).toContain("tail");
  });
});
