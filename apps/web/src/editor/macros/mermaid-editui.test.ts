// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { mermaidMacro } from "./mermaid";
import { asMacroSource, type MacroContext } from "./registry";

// #174 / ADR-087 slice 4b: mermaid is the first first-party macro to adopt the unified inline editUI —
// a source textarea + live preview, reached via the single edit button. These verify the mount/save
// contract (the framework's first real consumer) without depending on the async mermaid render.
const ctx: MacroContext = { theme: "light" };

describe("mermaid inline editUI (#174 slice 4b)", () => {
  it("declares an inline editUI (so hasEditUI is true → the macro gets the single edit button)", () => {
    expect(mermaidMacro.editUI?.present).toBe("inline");
  });

  it("mounts a CM6 source pane seeded with the body; commits on blur, NOT per keystroke; destroy cleans up", () => {
    // #243 / ADR-111 C3: the source pane is a CM6 mini-editor (contenteditable), not a <textarea>. The
    // per-keystroke → local-preview-only vs blur → Y.Text-commit contract is exercised end-to-end in real
    // Chromium (macro-raw-vs-editui.spec); here (happy-dom, no layout to drive CM typing) we verify the
    // mount/blur/destroy contract: the source pane exists, a blur commits the CURRENT doc via save(), and
    // save is NOT called before the blur (no per-keystroke write).
    const container = document.createElement("div");
    const save = vi.fn();
    const ctrl = mermaidMacro.editUI!.mount(container, asMacroSource("graph TD; A-->B"), ctx, save);
    const src = container.querySelector('[data-testid="mermaid-edit-src"]') as HTMLElement;
    expect(src).toBeTruthy();
    expect(save).not.toHaveBeenCalled(); // nothing committed on mount

    src.dispatchEvent(new Event("blur")); // blur commits the current source to Y.Text (offset-invariant save)
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("graph TD; A-->B"); // the seeded source (read from the CM6 doc state)

    ctrl.destroy(); // teardown removes the editor DOM
    expect(container.querySelector('[data-testid="mermaid-edit-src"]')).toBeNull();
  });
});
