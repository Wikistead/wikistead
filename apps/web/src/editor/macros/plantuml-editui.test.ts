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

  // #525: the read surface already swapped a plantuml fence for host-rendered image bytes, but an OPEN
  // editUI kept showing source — no seam existed for it. These pin the seam: with a host renderer the
  // preview becomes the diagram; without one (or on a null result) it stays the degrade-to-source preview.
  describe("#525 host-mediated preview render", () => {
    const blob = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }); // PNG magic
    const objectUrl = () => {
      // happy-dom may not implement createObjectURL; stub both halves so the macro can build an <img>.
      URL.createObjectURL = vi.fn(() => "blob:plantuml-test") as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    };

    it("renders the diagram in the preview when the host lends a renderer", async () => {
      objectUrl();
      const container = document.createElement("div");
      const renderDiagram = vi.fn(async () => blob());
      const ctrl = plantumlMacro.editUI!.mount(container, asMacroSource("@startuml\nA -> B\n@enduml"), ctx, vi.fn(), { renderDiagram });
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="plantuml-edit-rendered"]')).toBeTruthy();
      });
      // the macro handed over only its SOURCE — it never sees the endpoint/lang (ADR-024 narrow host-API)
      expect(renderDiagram).toHaveBeenCalledWith("@startuml\nA -> B\n@enduml");
      expect(container.querySelector('[data-testid="plantuml-edit-preview"] code'), "source pre replaced by the image").toBeNull();
      ctrl.destroy();
    });

    it("keeps the degrade-to-source preview when the host renderer returns null (unconfigured / failed)", async () => {
      objectUrl();
      const container = document.createElement("div");
      const ctrl = plantumlMacro.editUI!.mount(container, asMacroSource("@startuml\nA -> B\n@enduml"), ctx, vi.fn(), { renderDiagram: async () => null });
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="plantuml-edit-preview"] code')).toBeTruthy();
      });
      expect(container.querySelector('[data-testid="plantuml-edit-rendered"]')).toBeNull(); // never a broken embed
      ctrl.destroy();
    });

    it("without a host renderer the preview is unchanged (no host → source, the shipped behaviour)", () => {
      const container = document.createElement("div");
      const ctrl = plantumlMacro.editUI!.mount(container, asMacroSource("@startuml\nA -> B\n@enduml"), ctx, vi.fn());
      expect(container.querySelector('[data-testid="plantuml-edit-preview"] code')?.textContent).toContain("@startuml");
      expect(container.querySelector('[data-testid="plantuml-edit-rendered"]')).toBeNull();
      ctrl.destroy();
    });

    it("destroy invalidates an in-flight render (a late result never touches the detached panel)", async () => {
      objectUrl();
      const container = document.createElement("div");
      let resolve!: (b: Blob | null) => void;
      const ctrl = plantumlMacro.editUI!.mount(container, asMacroSource("@startuml\nA -> B\n@enduml"), ctx, vi.fn(), {
        renderDiagram: () => new Promise<Blob | null>((r) => { resolve = r; }),
      });
      ctrl.destroy();      // panel closed while the render is still in flight
      resolve(blob());     // …and it lands afterwards
      await Promise.resolve();
      expect(container.querySelector('[data-testid="plantuml-edit-rendered"]')).toBeNull();
    });
  });
});
