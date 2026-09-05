// #1105: a disabled DropdownMenuItem's ONLY consumer of the disabled state (OverflowMenu.tsx's `hint`,
// wired to PageControls.tsx's "save as template" — the sole site combining `disabled` + `data-tip`
// anywhere in the app) puts `data-tip` on the SAME DOM node as `disabled`. `pointer-events: none` makes
// an element un-hoverable to the browser's own hit-testing, so `tooltip-host.ts`'s delegated
// `pointerover` listener (which finds its target via `e.target.closest("[data-tip]")`) can never see a
// disabled item — the ONE thing meant to say WHY the item is unavailable never shows.
//
// Verified live in Chromium (not just read here): a standalone repro with the pre-fix class
// (`pointer-events:none`) never fired a real mouse hover's `pointerover`; the post-fix class
// (`cursor-not-allowed`, pointer-events left enabled) did, and the tooltip bubble rendered. This pin
// guards the regression at the source: no @testing-library/react in this package (see
// hint-order-881.test.ts's own note), so — like that pin — this reads the CLASS STRING rather than a
// rendered DOM, which is faithful here because the string is the one place either failure mode lives.
//
// Removing `pointer-events-none` is safe because Radix's own MenuItem already gates disabled at the JS
// level, independent of CSS: `handleSelect` no-ops `if (!disabled)`, and `onPointerMove` skips the
// hover-highlight/focus path entirely `if (disabled)` (checked directly in
// @radix-ui/react-menu@2.1.18's dist/index.mjs). CSS pointer-events was never load-bearing for
// preventing activation — only for the (now traded off) hover LOOK.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "dropdown-menu.tsx"), "utf8");

describe("#1105: DropdownMenuItem stays hoverable when disabled (so its tooltip can fire)", () => {
  it("DropdownMenuItem's class string does not disable pointer-events when data-disabled", () => {
    const start = SRC.indexOf("function DropdownMenuItem(");
    expect(start, "DropdownMenuItem must exist in this file").toBeGreaterThan(-1);
    const end = SRC.indexOf("function DropdownMenuCheckboxItem(", start);
    const body = SRC.slice(start, end === -1 ? undefined : end);
    expect(body, "a disabled item must stay hit-testable so tooltip-host.ts's pointerover listener can reach its data-tip")
      .not.toContain("data-[disabled]:pointer-events-none");
  });

  it("DropdownMenuItem still visually communicates disabled (opacity + not-allowed cursor)", () => {
    const start = SRC.indexOf("function DropdownMenuItem(");
    const end = SRC.indexOf("function DropdownMenuCheckboxItem(", start);
    const body = SRC.slice(start, end);
    expect(body).toContain("data-[disabled]:opacity-50");
    expect(body, "cursor-not-allowed replaces pointer-events-none as the disabled affordance").toContain("data-[disabled]:cursor-not-allowed");
  });
});
