// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { plantumlMacro } from "./plantuml";
import { asMacroSource, type MacroContext } from "./registry";

// #174 / ADR-087 addendum (comment 716): plantuml gets the single edit button → an inline editUI so a
// non-vim / WYSIWYG user can edit it (raw is hidden there, and Ctrl+Enter is the vim×Live path). No
// bundled renderer → the panel is a source textarea + a degraded code preview. Same mount/save contract
// as mermaid (verified DOM-free here; the raw-vs-editUI routing is checked by the e2e).
const ctx: MacroContext = { theme: "light" };

describe("plantuml inline editUI (#174 addendum)", () => {
  it("declares an inline editUI (→ hasEditUI true → the macro gets the single edit button)", () => {
    expect(plantumlMacro.editUI?.present).toBe("inline");
  });

  it("mounts a CM6 source pane seeded with the body; the degraded preview shows it; commits on blur; destroy cleans up", () => {
    // #243 / ADR-111 C3: the source pane is a CM6 mini-editor, not a <textarea>. The per-keystroke →
    // local-preview vs blur → Y.Text-commit contract is exercised in real Chromium (macro-raw-vs-editui.spec);
    // here (happy-dom) we verify the mount/preview/blur/destroy contract.
    const container = document.createElement("div");
    const save = vi.fn();
    const ctrl = plantumlMacro.editUI!.mount(container, asMacroSource("@startuml\nA -> B\n@enduml"), ctx, save);
    const src = container.querySelector('[data-testid="plantuml-edit-src"]') as HTMLElement;
    expect(src).toBeTruthy();
    // the degraded code preview renders the seeded source (textContent, XSS-safe) on mount
    expect(container.querySelector('[data-testid="plantuml-edit-preview"] code')?.textContent).toBe("@startuml\nA -> B\n@enduml");
    expect(save).not.toHaveBeenCalled(); // nothing committed on mount

    src.dispatchEvent(new Event("blur")); // blur commits the current source to Y.Text
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("@startuml\nA -> B\n@enduml");

    ctrl.destroy();
    expect(container.querySelector('[data-testid="plantuml-edit-src"]')).toBeNull();
  });

  it("degraded preview uses textContent (never innerHTML) — XSS-safe for user source", () => {
    const container = document.createElement("div");
    const ctrl = plantumlMacro.editUI!.mount(container, asMacroSource("<img src=x onerror=alert(1)>"), ctx, vi.fn());
    const code = container.querySelector('[data-testid="plantuml-edit-preview"] code') as HTMLElement;
    expect(code.querySelector("img")).toBeNull(); // escaped, not parsed
    expect(code.textContent).toContain("<img");
    ctrl.destroy();
  });
});
