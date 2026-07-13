// #357every shipped slash-palette command must carry an EXPLICIT icon — the generic square fallback is
// reserved for a future, not-yet-mapped id, never for a command we ship today (the review found callout
// types + query lists silently falling to the square). This coverage test fails if any built-in / picker-gated
// / registry-macro command id lacks an explicit icon, so a new command can't ship iconless.
import { describe, it, expect } from "vitest";
import { allPaletteCommandIdsForCoverage } from "./palette"; // importing registers the first-party macros (side-effect)
import { hasExplicitPaletteIcon, paletteIcon } from "./palette-icons";

describe("palette icons cover every shipped command (#357)", () => {
  const ids = allPaletteCommandIdsForCoverage();

  it("enumerates the full command universe (built-ins + callout types + layout/diagram/embed macros)", () => {
    // Sanity: the callout types + the query lists (the regressed ids) are present.
    for (const id of ["macro:note", "macro:info", "macro:tip", "macro:warning", "macro:danger", "query-children", "query-tag", "insert-template", "page-link"]) {
      expect(ids).toContain(id);
    }
  });

  it("every command id has an EXPLICIT icon (none falls through to the generic square)", () => {
    const missing = ids.filter((id) => !hasExplicitPaletteIcon(id));
    expect(missing, `these command ids have no explicit icon → fix palette-icons.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("every icon is a well-formed, theme-following inline svg", () => {
    for (const id of ids) {
      const svg = paletteIcon(id);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('stroke="currentColor"'); // follows the row theme (light/dark)
      expect(svg).toContain('width="16"');
    }
  });
});
