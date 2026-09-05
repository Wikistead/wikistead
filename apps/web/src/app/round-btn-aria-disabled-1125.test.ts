// @vitest-environment happy-dom
// #1125: a real disabled <button> never dispatches pointerover (a browser/form-control behaviour —
// unlike Radix's #1105, which was CSS pointer-events:none), so tooltip-host.ts's delegated listener
// could never see RoundBtn's own data-tip (its only label) while disabled. Verified live in Chromium
// (real mouse hover, via claude-in-chrome): hovering the disabled movePinUp button in the sidebar
// produced no tooltip, while the enabled movePinDown button beside it did. Fixed by swapping the
// native `disabled` attribute for `aria-disabled` + an onClick guard.
//
// RoundBtn has no hooks of its own, so — unlike its callers (PageActions pulls in useTranslation /
// useDirty / useWatchItem) — it renders standalone with real react-dom/client (the pattern
// ScimPendingBanner-dismiss-1104.test.ts established; no @testing-library/react in this package).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RoundBtn } from "./PageControls";

function render(props: Parameters<typeof RoundBtn>[0]): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  let root!: Root;
  act(() => { root = createRoot(container); root.render(createElement(RoundBtn, props)); });
  return { container, root };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("#1125: RoundBtn stays hoverable when disabled (so its data-tip can fire)", () => {
  it("disabled=true is NOT the native disabled attribute (that's what blocked pointerover)", () => {
    const { container } = render({ label: "Publish", icon: null, testId: "publish-page", disabled: true });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="publish-page"]')!;
    expect(btn.disabled, "a native-disabled button never receives pointerover — the exact #1125 defect").toBe(false);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
  });

  it("enabled (disabled=undefined) carries no aria-disabled at all", () => {
    const { container } = render({ label: "Publish", icon: null, testId: "publish-page" });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="publish-page"]')!;
    expect(btn.disabled).toBe(false);
    expect(btn.hasAttribute("aria-disabled")).toBe(false);
  });

  it("clicking while disabled does NOT invoke onClick (aria-disabled alone does not block activation)", () => {
    const onClick = vi.fn();
    const { container } = render({ label: "Publish", icon: null, testId: "publish-page", disabled: true, onClick });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="publish-page"]')!;
    act(() => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("clicking while enabled DOES invoke onClick", () => {
    const onClick = vi.fn();
    const { container } = render({ label: "Publish", icon: null, testId: "publish-page", onClick });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="publish-page"]')!;
    act(() => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onClick).toHaveBeenCalledOnce();
  });
});
