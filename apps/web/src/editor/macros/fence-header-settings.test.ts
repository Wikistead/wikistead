// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { buildFenceHeader } from "./md-render";

// #456 rev (review ①/④): the code-settings ✎ lives in the code HEADER chrome (next to the copy
// button), not a floating hoverTooltip — so it is in the same top-right corner group (①) and visible to
// caret/keyboard users whenever the block renders, not only on mouse hover (④). It is EDIT-surface only:
// the caller passes onSettings iff the fence-settings field is registered, so the read/render surface
// (no onSettings) never gets a ✎. These pins are the unit-verifiable half; the visual position / DS look /
// double-frame removal are device-visual (needs-human-check).

describe("buildFenceHeader code-settings ✎ (#456)", () => {
  it("renders the ✎ settings button when onSettings is provided, to the LEFT of the copy button", () => {
    const onSettings = vi.fn();
    const row = buildFenceHeader({ lang: "ts", code: "x", canCopy: true, onSettings, settingsLabel: "Code settings" });
    const gear = row.querySelector<HTMLButtonElement>(".cm-lp-code-settings-btn");
    const copy = row.querySelector<HTMLButtonElement>(".cm-lp-code-copy");
    expect(gear).not.toBeNull();
    expect(copy).not.toBeNull();
    expect(gear!.getAttribute("data-testid")).toBe("fence-settings-hint");
    expect(gear!.getAttribute("aria-label")).toBe("Code settings");
    // DOM order: ✎ precedes copy → it sits to copy's LEFT in the flex row.
    expect(gear!.compareDocumentPosition(copy!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("clicking the ✎ invokes onSettings (opens the panel)", () => {
    const onSettings = vi.fn();
    const row = buildFenceHeader({ lang: "ts", code: "x", canCopy: true, onSettings });
    row.querySelector<HTMLButtonElement>(".cm-lp-code-settings-btn")!.click();
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("renders NO ✎ on the read/render surface (onSettings absent) — edit-only", () => {
    const row = buildFenceHeader({ lang: "ts", code: "x", canCopy: true });
    expect(row.querySelector(".cm-lp-code-settings-btn")).toBeNull();
    expect(row.querySelector(".cm-lp-code-copy")).not.toBeNull(); // copy still there
  });

  it("a bare fence (no lang) still gets the ✎ when editable", () => {
    const onSettings = vi.fn();
    const row = buildFenceHeader({ lang: "", code: "x", canCopy: true, onSettings });
    expect(row.querySelector(".cm-lp-code-settings-btn")).not.toBeNull(); // the bare-fence settings entry-point
  });
});
