// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { installTooltipHost } from "./tooltip-host";

// #530 review rejection: the sidebar tooltip appeared when the cursor sat mid-name but NOT near the name's
// right end. Measured cause: hovering reveals the row's menu buttons, the name span SHRINKS, and the
// cursor — which had not moved — is suddenly over the ROW instead of the name. The host read that as
// leaving and hid. Anchoring on the row and measuring the name inside it (data-tip-measure) means the
// pointer stays within the anchor no matter how the inner label resizes.
//
// Pinned here rather than in a browser: reproducing it e2e needs the row's hover buttons to actually
// appear and to shrink the label past the cursor, which the seeded fixture does not do — a spec written
// against it passed with the bug still in place (verified), so it would have been a vacuous guard.
const widths = (el: HTMLElement, scrollW: number, clientW: number) => {
  Object.defineProperty(el, "scrollWidth", { value: scrollW, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientW, configurable: true });
};
const bubble = () => document.querySelector(".wks-tip") as HTMLElement | null;

function buildRow(opts: { anchorOnRow: boolean }) {
  document.body.innerHTML = "";
  const row = document.createElement("div");
  const name = document.createElement("span");
  name.setAttribute("data-testid", "tree-page-name");
  name.textContent = "a long page name";
  widths(name, 250, 171); // clipped
  if (opts.anchorOnRow) {
    row.dataset.tipIfTruncated = "a long page name";
    row.dataset.tipMeasure = "[data-testid=tree-page-name]";
  } else {
    name.dataset.tipIfTruncated = "a long page name"; // the pre-fix anchoring
  }
  row.appendChild(name);
  document.body.appendChild(row);
  return { row, name };
}

describe("#530: the tooltip anchor survives the label shrinking under the cursor", () => {
  beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ""; });

  it("keeps the tooltip when the pointer ends up on the ROW (the label moved, not the pointer)", () => {
    installTooltipHost();
    const { row, name } = buildRow({ anchorOnRow: true });

    name.dispatchEvent(new Event("pointerover", { bubbles: true }));
    // the buttons appear, the name shrinks away from the cursor → the next pointerover targets the row
    row.dispatchEvent(new Event("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(1000);

    expect(bubble()?.textContent, "the row is still the anchor, so nothing 'left'").toBe("a long page name");
  });

  it("measures the INNER label, not the anchor (a row is never clipped itself)", () => {
    installTooltipHost();
    const { row, name } = buildRow({ anchorOnRow: true });
    widths(row, 400, 400); // the row itself fits perfectly — only the name is clipped
    widths(name, 250, 171);

    row.dispatchEvent(new Event("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(1000);
    expect(bubble()?.textContent).toBe("a long page name");
  });

  it("says nothing when the inner label is NOT clipped (no needless bubbles)", () => {
    installTooltipHost();
    const { row, name } = buildRow({ anchorOnRow: true });
    widths(name, 171, 171); // fits

    row.dispatchEvent(new Event("pointerover", { bubbles: true }));
    vi.advanceTimersByTime(1000);
    expect(bubble()?.hidden ?? true).toBe(true);
  });
});
