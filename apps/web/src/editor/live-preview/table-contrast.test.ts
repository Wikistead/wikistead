import { describe, it, expect } from "vitest";
import { contrastColor } from "./table-edit";

// #209: a coloured table cell must stay legible in BOTH themes — dark text on a light fill, light on
// a dark one. The palette tints are light, so dark mode's light text would otherwise vanish on them.
describe("contrastColor (#209 table cell legibility)", () => {
  it("returns dark text for the light palette tints", () => {
    for (const bg of ["#fde8e8", "#fef3c7", "#e7f6e7", "#e6f0fb"]) {
      expect(contrastColor(bg)).toBe("#1f2328");
    }
  });

  it("returns light text for a dark fill", () => {
    expect(contrastColor("#1e1e1e")).toBe("#ffffff");
    expect(contrastColor("#000000")).toBe("#ffffff");
  });

  it("uses the accent's paired foreground token for the accent fill", () => {
    expect(contrastColor("var(--accent)")).toBe("var(--accent-fg)");
  });

  it("clears the colour when the fill is cleared (inherit the theme)", () => {
    expect(contrastColor(undefined)).toBeUndefined();
  });

  it("ignores an unparseable value (no colour override)", () => {
    expect(contrastColor("notacolor")).toBeUndefined();
  });
});
