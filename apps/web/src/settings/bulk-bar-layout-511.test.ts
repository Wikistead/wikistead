// #511 the bulk bar's selection count wrapped ONE CHARACTER PER LINE.
//
// The count was the only shrinkable child in a row of six buttons, so once the buttons claimed the width
// flex squeezed it. English breaks at spaces and merely looks cramped; Japanese has no word boundaries, so
// the Japanese "183 selected" copy became a vertical column of glyphs and the bar grew tall. That is why the bug reached the
// user through a screenshot rather than through a test — the default locale hides it.
//
// The fix is structural (every child shrink-0, the row wraps), so the pin is structural too: a lexical
// check on the markup, in the style of the #510 destructive-guard. A DOM test would be stronger, but this
// component needs the query client, the router outlet and i18n to render, and the property here — "nothing
// in the bar may be shrunk" — is exactly a property of the markup.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "./SpacePagesTab.tsx"), "utf8");

// The bar element and everything up to its closing tag.
function bulkBarMarkup(): string {
  const start = SRC.indexOf('data-testid="space-pages-bulkbar"');
  expect(start, "the bulk bar still exists").toBeGreaterThan(-1);
  const end = SRC.indexOf("</div>", start);
  return SRC.slice(SRC.lastIndexOf("<div", start), end);
}

describe("#511 bulk bar layout", () => {
  it("the selection count cannot be shrunk, so it never wraps mid-word", () => {
    const bar = bulkBarMarkup();
    const count = bar.slice(bar.indexOf('data-testid="bulk-selected-count"') - 200, bar.indexOf('data-testid="bulk-selected-count"'));
    expect(count, "the count is shrink-0").toContain("shrink-0");
    expect(count, "and never breaks inside itself").toContain("whitespace-nowrap");
  });

  it("every control in the bar is shrink-0 and the row wraps instead of crushing them", () => {
    const bar = bulkBarMarkup();
    expect(bar, "the row wraps at narrow widths").toContain("flex-wrap");
    // Non-vacuity: there really are several buttons in this bar, so the assertion below has work to do.
    const buttons = bar.match(/<Button/g)?.length ?? 0;
    expect(buttons, "the bar still holds its action buttons").toBeGreaterThanOrEqual(6);
    const unshrinkable = (bar.match(/<Button(?![^>]*shrink-0)/g) ?? []).length;
    expect(unshrinkable, "no button may be squeezed by its neighbours").toBe(0);
  });

  it("the destructive action is separated from the ordinary ones", () => {
    const bar = bulkBarMarkup();
    const del = bar.indexOf('data-testid="bulk-delete"');
    expect(del, "delete is in the bar").toBeGreaterThan(-1);
    // ml-auto pushes delete (and the clear-selection escape) away from the safe verbs, so the click that
    // trashes pages is not adjacent to the one that exports them.
    expect(bar.slice(del - 200, del), "delete is pushed to the end").toContain("ml-auto");
  });
});
