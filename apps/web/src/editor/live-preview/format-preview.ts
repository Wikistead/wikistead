// #612: the format buttons PREVIEW their effect — shared by the selection bubble (toolbar.ts) and the
// table-cell bar (cell-inline-format.ts), so the two faces cannot drift. Lives in its OWN module with
// no runtime imports from the editor graph: toolbar → palette → decorations is a heavy cycle, and the
// first cut (helper exported from toolbar.ts, imported by cell-inline-format.ts) closed that cycle and
// crashed the editor at load — every e2e died at openDemo before a single assertion ran.
import { paletteIcon } from "./palette-icons";
import type { InlineFormat } from "./commands";

// The bold button is bold, the italic one slants, strike is struck through, and the highlight one
// wears the SAME marker tint the body's `==text==` renders with (`lp-btn-preview-highlight` mirrors
// .cm-lp-highlight / mark — one recipe, tokens only). Link is an icon (#544: icon, never a word),
// from the same trusted inline-SVG set the `/` palette draws (palette-icons.ts, lucide paths).
export function formatButtonContent(fmt: Pick<InlineFormat, "id" | "symbol">): string | HTMLElement {
  if (fmt.id === "link") {
    const span = document.createElement("span");
    span.className = "lp-btn-icon";
    span.setAttribute("aria-hidden", "true");
    span.innerHTML = paletteIcon("link");
    return span;
  }
  if (fmt.id === "bold" || fmt.id === "italic" || fmt.id === "strike" || fmt.id === "highlight") {
    const span = document.createElement("span");
    span.className = `lp-btn-preview lp-btn-preview-${fmt.id}`;
    span.textContent = fmt.symbol;
    return span;
  }
  return fmt.symbol; // `</>` for inline code stays a glyph (the ticket leaves it to implementation)
}
