// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import "./index"; // registers every first-party macro
import { registeredMacros } from "./registry";
import { renderMarkdownToDom } from "./md-render";

// #450 / ADR-177 anti-test ("parity matrix"): for every registered macro, rendering it NESTED inside a
// container must reach the same dispatch it reaches at the top level. This ticket's whole history is the
// same bug arriving through different doors — a host-dependent feature wired into the top-level path and
// not into the nested one, so a macro silently renders "top-level only". The matrix is the structural
// answer: a macro that only works at depth 0 fails here rather than in someone's document.
//
// What it compares is the DISPATCH SIGNATURE — which macro produced the element — not layout or async
// content. Async host resolution (the list macros' placeholder → fetch → swap) is deliberately out of
// scope here: this asserts the render reached the macro's own renderer at every depth, which is the part
// that has broken. Layout and real host fetches are pinned in the browser specs.
//
// Depth stops at one container because MAX_NESTED_DIRECTIVE_DEPTH is 2 (#90): past it a nested directive
// deliberately stops spawning live layouts and shows its content in a plain box. That degradation is the
// product decision, so the matrix pins it as such (below) rather than reading it as a parity failure.

// A one-block sample of each macro's source. Fence macros get their fence, directives their `:::` block.
// Bodies are minimal on purpose: this measures dispatch, not content.
const SAMPLE: Record<string, string> = {
  mermaid: "```mermaid\ngraph TD; A-->B;\n```",
  plantuml: "```plantuml\n@startuml\nA -> B\n@enduml\n```",
  excalidraw: '```excalidraw\n{"elements":[]}\n```',
  table: ":::table\n| a | b |\n| - | - |\n| 1 | 2 |\n:::",
  note: ":::note[Label]\nbody\n:::",
  info: ":::info\nbody\n:::",
  tip: ":::tip\nbody\n:::",
  warning: ":::warning\nbody\n:::",
  danger: ":::danger\nbody\n:::",
  todo: ":::todo\n- [ ] one\n:::",
  details: ":::details[More]\nbody\n:::",
  "embed-page": ":::embed-page\npage-123\n:::",
  "embed-external": ":::embed-external\nhttps://example.com/x\n:::",
  tagged: ":::tagged\nrecipes\n:::",
  children: ":::children\n:::",
  columns: "::::columns\n:::column\ninner\n:::\n::::",
  tabs: "::::tabs\n:::tab[One]\ninner\n:::\n::::",
};

// Nest `src` inside a container, raising the outer fence length so the inner `:::` blocks still close.
const nest = (src: string, depth: number): string => {
  let out = src;
  for (let d = 0; d < depth; d++) {
    const colons = ":".repeat(4 + d * 2);
    const inner = ":".repeat(3 + d * 2);
    out = `${colons}columns\n${inner}column\n${out}\n${inner}\n${colons}`;
  }
  return out;
};

// The dispatch fingerprint of a render: which macro-owned elements exist, ignoring text and ordering
// noise. `data-macro`/`data-testid`/`class` are how each renderer signs its output.
function fingerprint(frag: DocumentFragment): string[] {
  const host = document.createElement("div");
  host.appendChild(frag.cloneNode(true));
  const marks: string[] = [];
  for (const el of Array.from(host.querySelectorAll("*"))) {
    const testid = el.getAttribute("data-testid");
    if (testid && /^macro-/.test(testid)) marks.push(`testid:${testid}`);
    for (const c of Array.from(el.classList)) {
      if (/^(cm-lp-(macro|callout|columns|tabs|details|table|query|fence)|embed-|excalidraw|mermaid|plantuml|todo|callout)/.test(c)) {
        marks.push(`class:${c}`);
      }
    }
  }
  return [...new Set(marks)].sort();
}

describe("#450: every macro reaches the same dispatch nested as it does at the top level", () => {
  const macros = registeredMacros().map((m) => (m.kind === "fence" ? m.lang : m.name));

  it("has a sample for every registered macro (a new macro joins the matrix, not skips it)", () => {
    expect(macros.filter((n) => SAMPLE[n] === undefined)).toEqual([]);
  });

  // #90: the cap is a decision, not a gap — past it a directive still shows its CONTENT, it just stops
  // building live layouts. Pinned so the cap cannot quietly become "the block disappears".
  it("past the nesting cap a directive degrades to plain content, never to nothing", () => {
    const deep = renderMarkdownToDom(nest(SAMPLE.note!, 2));
    const host = document.createElement("div");
    host.appendChild(deep);
    expect(host.textContent).toContain("body");
    expect(host.querySelector(".cm-lp-md-directive")).not.toBeNull();
  });

  for (const name of Object.keys(SAMPLE)) {
    it(`${name}: depth 0 / 1 / 2 dispatch alike`, () => {
      const top = fingerprint(renderMarkdownToDom(SAMPLE[name]!));
      expect(top.length, `${name} produced no macro-owned element even at the top level`).toBeGreaterThan(0);
      const nested = fingerprint(renderMarkdownToDom(nest(SAMPLE[name]!, 1)));
      // The container itself signs the nested render, so the nested set is the top set PLUS the wrapper.
      const missing = top.filter((m) => !nested.includes(m));
      expect(missing, `${name} loses its own dispatch when nested`).toEqual([]);
    });
  }
});
