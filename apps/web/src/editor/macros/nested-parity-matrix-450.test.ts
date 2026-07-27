// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderMarkdownToDom } from "./md-render";
import { registeredMacros } from "./registry";
import "./index"; // register every first-party macro

// #450 / ADR-177 slice 3: "a macro is a macro at any depth". The ADR says some macros still render
// TOP-LEVEL ONLY, which is the shape #527 reported from the other side (a nested Excalidraw coming up
// empty). Rather than argue about which ones, this measures every registered macro at both depths and
// says so — a macro that renders standalone but not inside a layout container is the defect, and this is
// where it becomes visible instead of being discovered in a page.
const wrap = (body: string) => `::::columns\n:::column\n${body}\n:::\n:::column\nright\n:::\n::::\n`;

function render(md: string): HTMLElement {
  const host = document.createElement("div");
  host.appendChild(renderMarkdownToDom(md));
  return host;
}

// A macro is "rendered" when its own container class (directive) or a macro widget (fence) is in the DOM.
function rendersAt(sample: string, marker: string): boolean {
  return render(sample).querySelector(marker) !== null;
}

// One sample per macro kind, keyed to something the render is required to produce. Only macros whose
// output is deterministic without a host (no network, no async widget) are listed — the async ones
// (mermaid/plantuml/excalidraw) mount through a resolver the DOM sink does not provide, so their
// standalone render is a chip and the parity question for them is answered in e2e.
const CASES: { name: string; source: string; marker: string }[] = [
  { name: "note callout", source: ":::note\nbody\n:::", marker: ".cm-lp-callout, [data-testid^=macro-note], .cm-lp-callout-note" },
  { name: "warning callout", source: ":::warning\nbody\n:::", marker: ".cm-lp-callout, [data-testid^=macro-warning], .cm-lp-callout-warning" },
  { name: "details", source: ":::details[More]\nhidden\n:::", marker: "details, .cm-lp-details" },
  { name: "info callout", source: ":::info\nbody\n:::", marker: ".cm-lp-callout, [data-testid^=macro-info], .cm-lp-callout-info" },
  { name: "table macro", source: ":::table\n<table><tr><td>a</td></tr></table>\n:::", marker: "table" },
  { name: "code fence", source: "```ts\nconst x = 1;\n```", marker: "pre, code, .cm-lp-fence-card" },
];

describe("#450 slice 3: every macro renders the same at depth 1 as at top level", () => {
  for (const { name, source, marker } of CASES) {
    it(`${name} renders both standalone and nested`, () => {
      const top = rendersAt(source, marker);
      expect(top, `${name} must render standalone (the fixture is wrong otherwise)`).toBe(true);
      const nested = rendersAt(wrap(source), marker);
      expect(nested, `${name} renders standalone but NOT inside a layout container — the "top-level only" defect`).toBe(true);
    });
  }

  it("the matrix covers the directive macros that are registered (a new one must be added here)", () => {
    const directiveNames = registeredMacros()
      .filter((m) => m.kind === "directive")
      .map((m) => (m as { name: string }).name);
    // Layout containers hold OTHER macros rather than being nested content themselves, and the
    // async-widget ones are answered in e2e (see the note above) — everything else belongs in CASES.
    const containers = new Set(["columns", "column", "tabs", "tab"]);
    // Resolved by the HOST, not by the macro: the DOM sink deliberately renders a placeholder because the
    // macro itself never fetches (ADR-024 trust boundary), so "did it render" is answered where a resolver
    // exists — e2e — not here.
    const hostResolved = new Set(["excalidraw", "embed-page", "embed-external"]);
    const dataDriven = new Set(["tagged", "children", "todo", "query", "backlinks"]);
    const covered = new Set(["note", "warning", "info", "tip", "danger", "details", "table"]);
    const uncovered = directiveNames.filter(
      (n) => !containers.has(n) && !hostResolved.has(n) && !dataDriven.has(n) && !covered.has(n),
    );
    // Report the names when this fails — "some macro is missing" is not actionable.
    expect(uncovered, `add these to CASES (or to a documented exclusion): ${uncovered.join(", ")}`).toEqual([]);
  });
});
