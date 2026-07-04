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

  it("mounts a source textarea seeded with the body; saves on change (blur), NOT per keystroke", () => {
    const container = document.createElement("div");
    const save = vi.fn();
    const ctrl = plantumlMacro.editUI!.mount(container, asMacroSource("@startuml\nA -> B\n@enduml"), ctx, save);
    const ta = container.querySelector('[data-testid="plantuml-edit-src"]') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.value).toBe("@startuml\nA -> B\n@enduml"); // seeded with the current source

    // input drives the LOCAL degraded preview only — it must NOT write to Y.Text
    ta.value = "@startuml\nA -> C\n@enduml";
    ta.dispatchEvent(new Event("input"));
    expect(save).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="plantuml-edit-preview"] code')?.textContent).toBe("@startuml\nA -> C\n@enduml");

    // change (blur) commits the new source to Y.Text
    ta.dispatchEvent(new Event("change"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("@startuml\nA -> C\n@enduml");

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
