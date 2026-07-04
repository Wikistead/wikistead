// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { calloutMacros } from "./callout";
import { asMacroSource, type MacroContext } from "./registry";

// #174 / ADR-087 slice 4b: callouts adopt the unified inline editUI — a type/label bar + a body
// textarea. sourceScope "block" (the editor reconstructs the whole `:::type[label]…:::`) so it can
// change the callout TYPE, which a body-only scope can't. These verify parse + reconstruct on the real
// macro without the CM host.
const ctx: MacroContext = { theme: "light" };
const infoCallout = calloutMacros.find((m) => m.name === "info")!;

describe("callout inline editUI (#174 slice 4b)", () => {
  it("declares a block-scoped inline editUI", () => {
    expect(infoCallout.editUI?.present).toBe("inline");
    expect(infoCallout.editUI?.sourceScope).toBe("block"); // needs the whole block to change the type
  });

  it("seeds the type/label/body from the block source; changing the TYPE reconstructs the directive", () => {
    const container = document.createElement("div");
    const save = vi.fn();
    const src = asMacroSource(":::info[Heads up]\nbody line 1\nbody line 2\n:::");
    const ctrl = infoCallout.editUI!.mount(container, src, ctx, save);

    const typeSel = container.querySelector('[data-testid="callout-edit-type"]') as HTMLSelectElement;
    const labelIn = container.querySelector('[data-testid="callout-edit-label"]') as HTMLInputElement;
    const bodyTa = container.querySelector('[data-testid="callout-edit-body"]') as HTMLTextAreaElement;
    expect(typeSel.value).toBe("info");
    expect(labelIn.value).toBe("Heads up");
    expect(bodyTa.value).toBe("body line 1\nbody line 2");

    // change the type → the whole directive is rebuilt with the new type, label + body preserved
    typeSel.value = "warning";
    typeSel.dispatchEvent(new Event("change"));
    expect(save).toHaveBeenLastCalledWith(":::warning[Heads up]\nbody line 1\nbody line 2\n:::");

    // clearing the label drops the [..] header
    labelIn.value = "";
    labelIn.dispatchEvent(new Event("change"));
    expect(save).toHaveBeenLastCalledWith(":::warning\nbody line 1\nbody line 2\n:::");

    ctrl.destroy();
    expect(container.querySelector('[data-testid="callout-edit-type"]')).toBeNull();
  });
});
