// The per-mode syntax-reveal decision (#168 / ADR-078 + ADR-056). Pure — the single source of truth
// shared by the inline/block reveal and math, so the four display modes can't diverge. WYSIWYG is
// the inverse of source: source always reveals raw markers, WYSIWYG never does (always rendered).
import { describe, it, expect } from "vitest";
import { syntaxRevealsAt } from "./decorations";

describe("syntaxRevealsAt (#168 / ADR-078)", () => {
  it("readOnly (reading / view) NEVER reveals, in any mode", () => {
    for (const m of ["live", "source", "reading", "wysiwyg"] as const) {
      expect(syntaxRevealsAt(m, true, true)).toBe(false);
      expect(syntaxRevealsAt(m, true, false)).toBe(false);
    }
  });

  it("source ALWAYS reveals (raw everywhere), regardless of the caret", () => {
    expect(syntaxRevealsAt("source", false, false)).toBe(true);
    expect(syntaxRevealsAt("source", false, true)).toBe(true);
  });

  it("wysiwyg NEVER reveals (inverse of source), even under the caret", () => {
    expect(syntaxRevealsAt("wysiwyg", false, true)).toBe(false);
    expect(syntaxRevealsAt("wysiwyg", false, false)).toBe(false);
  });

  it("live reveals ONLY where the caret/selection overlaps the marker", () => {
    expect(syntaxRevealsAt("live", false, true)).toBe(true); // caret on the marker → raw
    expect(syntaxRevealsAt("live", false, false)).toBe(false); // elsewhere → rendered
  });

  it("source and wysiwyg are opposites at the same caret position", () => {
    expect(syntaxRevealsAt("source", false, false)).toBe(true);
    expect(syntaxRevealsAt("wysiwyg", false, false)).toBe(false);
  });
});
