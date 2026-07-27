// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderMarkdownToDom, withTranscludeHost, withDiagramHost } from "./md-render";
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

// #450 slice 3 (the diagram half): a host-rendered diagram nested in a container used to show its SOURCE
// while an identical block one level up showed a picture, because the swap lived in the top-level widget.
// The macro cannot fetch (ADR-024), so the host renders and the nested dispatch swaps — and a failure keeps
// the source card, since a broken embed is worse than plain text.
const NESTED_DIAGRAM = "::::columns\n:::column\n```plantuml\n@startuml\nA -> B\n@enduml\n```\n:::\n::::\n";

describe("#450 slice 3: a nested host-rendered diagram becomes a picture", () => {
  const seam = (result: unknown) => ({
    handles: (lang: string) => lang === "plantuml",
    render: async () => result as never,
  });

  it("swaps in the rendered image when the host produces one", async () => {
    const out = withDiagramHost(seam({ ok: true, blob: new Blob(["x"], { type: "image/png" }) }), () => render(NESTED_DIAGRAM));
    await flush();
    expect(out.querySelector("[data-testid=macro-diagram-nested]"), "the nested diagram rendered").not.toBeNull();
  });

  it("accepts the legacy bare-Blob shape the existing renderer returns", async () => {
    const out = withDiagramHost(seam(new Blob(["x"], { type: "image/png" })), () => render(NESTED_DIAGRAM));
    await flush();
    expect(out.querySelector("[data-testid=macro-diagram-nested]")).not.toBeNull();
  });

  it("keeps the source card when the host cannot render it", async () => {
    const out = withDiagramHost(seam({ ok: false, reason: "unavailable" }), () => render(NESTED_DIAGRAM));
    await flush();
    expect(out.querySelector("[data-testid=macro-diagram-nested]"), "no broken embed").toBeNull();
    expect(out.textContent, "the source is still there to read").toContain("startuml");
  });

  it("leaves a lang the host does not handle alone", async () => {
    const out = withDiagramHost({ handles: () => false, render: async () => new Blob(["x"]) }, () => render(NESTED_DIAGRAM));
    await flush();
    expect(out.querySelector("[data-testid=macro-diagram-nested]")).toBeNull();
  });
});
