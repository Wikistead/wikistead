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

  it("mounts a source textarea seeded with the body; saves on change (blur), NOT per keystroke", () => {
    const container = document.createElement("div");
    const save = vi.fn();
    const ctrl = mermaidMacro.editUI!.mount(container, asMacroSource("graph TD; A-->B"), ctx, save);
    const ta = container.querySelector('[data-testid="mermaid-edit-src"]') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.value).toBe("graph TD; A-->B"); // seeded with the current source

    // input drives the LOCAL preview only — it must NOT write to Y.Text (else the host re-mounts the
    // widget mid-typing and the textarea resets)
    ta.value = "graph TD; A-->C";
    ta.dispatchEvent(new Event("input"));
    expect(save).not.toHaveBeenCalled();

    // change (blur) commits the new source to Y.Text
    ta.dispatchEvent(new Event("change"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("graph TD; A-->C");

    // teardown removes the editor DOM
    ctrl.destroy();
    expect(container.querySelector('[data-testid="mermaid-edit-src"]')).toBeNull();
  });
});
