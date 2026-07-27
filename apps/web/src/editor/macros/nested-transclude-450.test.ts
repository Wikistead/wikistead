// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderMarkdownToDom, withTranscludeHost } from "./md-render";
import "./index";

// #450 / ADR-177 slice 3: host-mediated resolution reached only the TOP-LEVEL widget, so an `:::embed-page`
// nested in a layout container rendered its placeholder and stayed there — the "renders top-level only"
// defect the ADR names. The macro still never fetches (ADR-024): the host installs a seam around the
// render, exactly as it already did for `:::tagged` / `:::children`, and a sink without one keeps the
// placeholder, which is the honest answer when nobody can resolve.
const NESTED = (ref: string) => `::::columns\n:::column\n:::embed-page\n${ref}\n:::\n:::\n:::column\nright\n:::\n::::\n`;

const render = (md: string): HTMLElement => {
  const host = document.createElement("div");
  host.appendChild(renderMarkdownToDom(md));
  return host;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("#450 slice 3: a nested embed-page resolves through the host seam", () => {
  it("renders the referenced markdown when the host can resolve it", async () => {
    const seam = { resolve: async () => "# Pulled in\n\nreferenced body", deniedLabel: "Cannot display this content" };
    const out = withTranscludeHost(seam, () => render(NESTED("page-1")));
    await flush();
    expect(out.textContent, "the referenced content is rendered in place").toContain("referenced body");
    expect(out.querySelector("h1")?.textContent, "…as markdown, not as text").toBe("Pulled in");
  });

  it("shows the uniform denied placeholder when it cannot — never why", async () => {
    const seam = { resolve: async () => null, deniedLabel: "Cannot display this content" };
    const out = withTranscludeHost(seam, () => render(NESTED("page-denied")));
    await flush();
    const ph = out.querySelector("[data-testid=macro-embed-page-denied]");
    expect(ph, "a placeholder, not the content").not.toBeNull();
    expect(ph!.textContent, "denied / cycle / absent read identically").toBe("Cannot display this content");
  });

  it("without a host it stays a placeholder — the macro never fetches on its own", async () => {
    const out = render(NESTED("page-1"));
    await flush();
    expect(out.textContent, "no content appears from nowhere").not.toContain("referenced body");
  });

  it("the seam does not outlive the render that installed it", async () => {
    const seam = { resolve: async () => "leaked", deniedLabel: "x" };
    withTranscludeHost(seam, () => render(NESTED("page-1")));
    const after = render(NESTED("page-1"));
    await flush();
    expect(after.textContent, "a later render has no host").not.toContain("leaked");
  });
});
