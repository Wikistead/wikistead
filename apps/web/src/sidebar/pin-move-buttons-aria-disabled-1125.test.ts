// #1125: the sidebar's page-pin and space-pin movePinUp/movePinDown buttons used the native
// `disabled` attribute together with their own `data-tip`. A native-disabled <button> never
// dispatches pointerover (a browser/form-control behaviour, not CSS), so tooltip-host.ts's
// delegated pointerover listener could never see the tooltip while the button sat at either end of
// the pin list. Verified live in Chromium (real mouse hover, via claude-in-chrome): hovering the
// disabled movePinUp button produced no tooltip; the enabled movePinDown button beside it did.
//
// Sidebar.tsx / SpaceSwitcher.tsx pull in react-query + routing + i18n context too heavily to render
// standalone here (unlike PageControls' RoundBtn — see round-btn-aria-disabled-1125.test.ts, which
// pins the same defect family with a real DOM render instead). This pin reads the shipped source,
// scoped to each button's own line (not a whole-file indexOf, which would let it borrow a
// neighbouring component's match) so it cannot be satisfied by an unrelated `aria-disabled` anywhere
// else in the file.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SIDEBAR_SRC = readFileSync(resolve(import.meta.dirname, "Sidebar.tsx"), "utf8");
const SWITCHER_SRC = readFileSync(resolve(import.meta.dirname, "SpaceSwitcher.tsx"), "utf8");

function lineContaining(src: string, needle: string): string {
  const line = src.split("\n").find((l) => l.includes(needle));
  expect(line, `expected a line containing ${JSON.stringify(needle)}`).toBeDefined();
  return line!;
}

describe("#1125: sidebar pin-move buttons stay hoverable when disabled", () => {
  it("Sidebar.tsx's page pin-up/pin-down use aria-disabled, never the native disabled attribute", () => {
    const up = lineContaining(SIDEBAR_SRC, 'data-testid="pin-up"');
    const down = lineContaining(SIDEBAR_SRC, 'data-testid="pin-down"');
    for (const line of [up, down]) {
      expect(line).toMatch(/\baria-disabled=\{/);
      expect(line, "the native disabled attribute blocks pointerover — that IS the #1125 defect").not.toMatch(/[^-]\bdisabled=\{/);
    }
  });

  it("Sidebar.tsx's onClick handlers guard the move themselves (aria-disabled does not block activation)", () => {
    const up = lineContaining(SIDEBAR_SRC, 'data-testid="pin-up"');
    const down = lineContaining(SIDEBAR_SRC, 'data-testid="pin-down"');
    expect(up).toContain("i !== 0 && movePin(");
    expect(down).toContain("i !== pagePins.length - 1 && movePin(");
  });

  it("Sidebar.tsx's headerBtn class styles aria-disabled, not disabled, and does not suppress pointer-events", () => {
    const cls = lineContaining(SIDEBAR_SRC, "const headerBtn =");
    expect(cls).toMatch(/aria-disabled:cursor-not-allowed/);
    expect(cls).toMatch(/aria-disabled:opacity-40/);
    expect(cls, "pointer-events-none reproduces the #1105 bug via CSS instead of the native attribute").not.toMatch(/disabled:pointer-events-none/);
  });

  it("SpaceSwitcher.tsx's space pin-up/pin-down use aria-disabled, never the native disabled attribute", () => {
    const up = lineContaining(SWITCHER_SRC, 'data-testid="space-pin-up"');
    const down = lineContaining(SWITCHER_SRC, 'data-testid="space-pin-down"');
    for (const line of [up, down]) {
      expect(line).toMatch(/\baria-disabled=\{/);
      expect(line).not.toMatch(/[^-]\bdisabled=\{/);
    }
  });

  it("SpaceSwitcher.tsx's onClick handlers guard the move themselves", () => {
    const up = lineContaining(SWITCHER_SRC, 'data-testid="space-pin-up"');
    const down = lineContaining(SWITCHER_SRC, 'data-testid="space-pin-down"');
    expect(up).toContain("if (pinIdx !== 0) onMovePin(");
    expect(down).toContain("if (pinIdx !== pinnedSpaceIds.length - 1) onMovePin(");
  });

  it("SpaceSwitcher.tsx's ctlBtn class styles aria-disabled, not disabled, and does not suppress pointer-events", () => {
    const cls = lineContaining(SWITCHER_SRC, "const ctlBtn =");
    expect(cls).toMatch(/aria-disabled:cursor-not-allowed/);
    expect(cls).toMatch(/aria-disabled:opacity-40/);
    expect(cls).not.toMatch(/disabled:pointer-events-none/);
  });
});
