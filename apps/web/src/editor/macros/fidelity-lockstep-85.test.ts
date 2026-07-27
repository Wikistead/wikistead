import { describe, it, expect } from "vitest";
import { builtinDirectiveDescriptors, builtinFenceDescriptors } from "@wikistead/macro-render";
import "./index"; // registers every first-party macro
import { registeredMacros } from "./registry";

// #85 / ADR-059 (5) + ADR-022 Part 6: "degradation is never silent". Two registries decide what an export
// says about a block — the EDITOR's (`exportFidelity` on each macro) and the SERVER's (the DOM-free
// descriptor table the export renderer dispatches through) — and only the server's is consulted when the
// badge is emitted. Nothing kept them in lockstep, so they drifted: `mermaid` and `excalidraw` claimed
// "preserve" on both sides while the export actually emitted the diagram's SOURCE and the literal words
// "[Excalidraw drawing]". A reader got a simplified block with nothing saying it had been simplified,
// which is the exact failure the fidelity contract exists to prevent.
//
// This pins the two properties that make drift impossible rather than merely fixed today:
//   1. every macro the editor registers is DISPATCHABLE server-side (or is an explicitly-listed
//      resolve-before-render macro), so a new macro cannot ship exporting as a bare box, and
//   2. where both registries know a macro, they agree on its fidelity — one truth, two surfaces.

// The macros with no server descriptor BY DESIGN. `:::tagged` / `:::children` are dynamic lists that are
// resolved into static Markdown BEFORE the renderer ever sees them (ADR-145 §4: the anonymous snapshot on
// the public surface, the viewer's own resolution in the HTML export), so a descriptor here would be dead
// code that could only ever produce the empty box the substitution exists to avoid. Listed — not silently
// skipped — so adding a third name is a decision someone makes on purpose.
const RESOLVED_BEFORE_RENDER = new Set(["tagged", "children"]);

const serverDescriptor = (m: { kind: string; lang?: string; name?: string }) =>
  m.kind === "fence" ? builtinFenceDescriptors[m.lang!] : builtinDirectiveDescriptors[m.name!];

const nameOf = (m: { kind: string; lang?: string; name?: string }) => (m.kind === "fence" ? m.lang! : m.name!);

describe("#85: the editor and server macro registries agree on export fidelity", () => {
  // #450 review: the check below runs editor → server, so a name that exists ONLY in the server
  // descriptor table is invisible to it — a descriptor for a macro nobody registers renders on the
  // export path and on no other surface, which is the same drift pointing the other way. ADR-177 §2
  // asks for name-set EQUALITY, so this closes the return direction.
  it("the server dispatches nothing the editor does not register", () => {
    const registered = new Set(registeredMacros().map((m) => (m.kind === "fence" ? m.lang! : m.name!)));
    const serverNames = [...Object.keys(builtinFenceDescriptors), ...Object.keys(builtinDirectiveDescriptors)];
    // `column`/`tab` are not macros: they are the ITEM syntax the columns/tabs renderers parse out of a
    // container body, so they have no registration by design.
    const itemNames = new Set(["column", "tab"]);
    const orphans = serverNames.filter((n) => !registered.has(n) && !itemNames.has(n));
    expect(orphans).toEqual([]);
  });

  it("every registered macro can be rendered server-side (or is resolved before render)", () => {
    const missing = registeredMacros()
      .filter((m) => !RESOLVED_BEFORE_RENDER.has(nameOf(m)))
      .filter((m) => serverDescriptor(m) === undefined)
      .map(nameOf);
    expect(missing).toEqual([]);
  });

  it("declares the same fidelity on both sides", () => {
    const drift = registeredMacros()
      .map((m) => ({ name: nameOf(m), editor: m.exportFidelity, server: serverDescriptor(m)?.exportFidelity }))
      .filter((r) => r.server !== undefined && r.server !== r.editor);
    expect(drift).toEqual([]);
  });

  it("marks the macros ADR-059 fixed as degrade — no headless render, so the badge is the honesty", () => {
    expect(builtinFenceDescriptors.mermaid?.exportFidelity).toBe("degrade");
    expect(builtinFenceDescriptors.excalidraw?.exportFidelity).toBe("degrade");
    expect(builtinFenceDescriptors.plantuml?.exportFidelity).toBe("degrade");
  });
});
