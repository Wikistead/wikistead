// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import i18n from "../../i18n";
import { calloutMacros } from "./callout";
import { asMacroSource, type MacroContext } from "./registry";

// #174 / ADR-087 slice 4b: callouts adopt the unified inline editUI — a type-chip row + header input +
// body textarea. sourceScope "block" (the editor reconstructs the whole `:::type[label]…:::`) so it can
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

    // #174 comment 883: the Type field is a row of visual chips (icon + variant colour + localized name),
    // not a bare <select>. The current type carries aria-pressed=true + the -on ring class.
    const infoChip = container.querySelector('[data-testid="callout-edit-type-info"]') as HTMLButtonElement;
    const labelIn = container.querySelector('[data-testid="callout-edit-label"]') as HTMLInputElement;
    const bodyTa = container.querySelector('[data-testid="callout-edit-body"]') as HTMLTextAreaElement;
    expect(infoChip.getAttribute("aria-pressed")).toBe("true"); // seeded from :::info
    expect(infoChip.classList.contains("cm-lp-callout-type-opt-on")).toBe(true);
    expect(infoChip.classList.contains("cm-lp-callout-info")).toBe(true); // variant colour/icon class
    expect(infoChip.querySelector(".cm-lp-callout-type-opt-icon")).not.toBeNull(); // mask-image icon span
    expect(labelIn.value).toBe("Heads up");
    expect(bodyTa.value).toBe("body line 1\nbody line 2");

    // clicking another type chip → the whole directive is rebuilt with the new type, label + body preserved
    const warnChip = container.querySelector('[data-testid="callout-edit-type-warning"]') as HTMLButtonElement;
    warnChip.dispatchEvent(new Event("mousedown"));
    expect(save).toHaveBeenLastCalledWith(":::warning[Heads up]\nbody line 1\nbody line 2\n:::");
    // the pressed state moved to the new type
    expect((container.querySelector('[data-testid="callout-edit-type-warning"]') as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect((container.querySelector('[data-testid="callout-edit-type-info"]') as HTMLButtonElement).getAttribute("aria-pressed")).toBe("false");

    // clearing the label drops the [..] header
    labelIn.value = "";
    labelIn.dispatchEvent(new Event("change"));
    expect(save).toHaveBeenLastCalledWith(":::warning\nbody line 1\nbody line 2\n:::");

    ctrl.destroy();
  });

  // #1170: the chip only had a `mousedown` listener, so a reader who tabbed onto it and pressed Enter
  // or Space — which fire `click`, not `mousedown`, on a real <button> — changed nothing. Mouse was the
  // only way in. Also the break-check for the click handler's `stopPropagation`: `activate` rebuilds
  // the whole button row (`renderTypes`) WHILE this click is still bubbling, and without it the event
  // reached a freshly-inserted SIBLING button's own listener too (measured: a bare dispatch here called
  // `save` a second time with the wrong type, last-call assertion below would see that second call).
  it("a type chip responds to keyboard activation (Enter/Space), exactly once", () => {
    const container = document.createElement("div");
    const save = vi.fn();
    const ctrl = infoCallout.editUI!.mount(container, asMacroSource(":::info\nx\n:::"), ctx, save);
    const dangerChip = container.querySelector('[data-testid="callout-edit-type-danger"]') as HTMLButtonElement;

    // A browser fires `click` with detail 0 for a keyboard-triggered activation on a focused button
    // no mousedown precedes it.
    dangerChip.dispatchEvent(new MouseEvent("click", { detail: 0, bubbles: true }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith(":::danger\nx\n:::");
    expect((container.querySelector('[data-testid="callout-edit-type-danger"]') as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");

    ctrl.destroy();
  });

  // The ordinary mouse path: mousedown applies the change; click still reaches the same listener
  // (browsers fire both), and `activate`'s own `type === ty` guard makes that second call a no-op
  // rather than a double commit.
  it("a real mouse click (mousedown, then its own click) commits the type change exactly once", () => {
    const container = document.createElement("div");
    const save = vi.fn();
    const ctrl = infoCallout.editUI!.mount(container, asMacroSource(":::info\nx\n:::"), ctx, save);
    const tipChip = container.querySelector('[data-testid="callout-edit-type-tip"]') as HTMLButtonElement;

    tipChip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    tipChip.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith(":::tip\nx\n:::");

    ctrl.destroy();
    expect(container.querySelector('[data-testid="callout-edit-type"]')).toBeNull();
  });

  it("#174 comment 878 point 1: each field carries a visible caption (Type / Header / Content) + placeholders", () => {
    const container = document.createElement("div");
    const ctrl = infoCallout.editUI!.mount(container, asMacroSource(":::info\nx\n:::"), ctx, vi.fn());
    const caps = Array.from(container.querySelectorAll(".cm-lp-callout-edit-cap")).map((e) => e.textContent);
    expect(caps).toEqual(["Type", "Header", "Content"]); // visible labels, not a bare form
    expect((container.querySelector('[data-testid="callout-edit-label"]') as HTMLInputElement).placeholder).toBeTruthy();
    expect((container.querySelector('[data-testid="callout-edit-body"]') as HTMLTextAreaElement).placeholder).toBeTruthy();
    ctrl.destroy();
  });

  it("#174 comment 883: the panel strings are localized — Japanese renders 種別/ヘッダー/本文 + ノート等", async () => {
    await i18n.changeLanguage("ja");
    try {
      const container = document.createElement("div");
      const ctrl = infoCallout.editUI!.mount(container, asMacroSource(":::info\nx\n:::"), ctx, vi.fn());
      expect(container.querySelector(".cm-lp-callout-edit-title")?.textContent).toBe("コールアウトを編集");
      const caps = Array.from(container.querySelectorAll(".cm-lp-callout-edit-cap")).map((e) => e.textContent);
      expect(caps).toEqual(["種別", "ヘッダー", "本文"]);
      // the type chips carry localized names too (shared with the icon-badge picker)
      expect(container.querySelector('[data-testid="callout-edit-type-note"]')?.textContent).toContain("ノート");
      expect(container.querySelector('[data-testid="callout-edit-type-warning"]')?.textContent).toContain("警告");
      expect((container.querySelector('[data-testid="callout-edit-label"]') as HTMLInputElement).placeholder).toBe("見出し（省略可）");
      ctrl.destroy();
    } finally {
      await i18n.changeLanguage("en"); // don't leak the language into other tests
    }
  });
});
