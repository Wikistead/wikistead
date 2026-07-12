import { EditorView, Decoration, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import i18n from "../../i18n";
import { notify } from "../../ui/toast";
import { extractHeadings } from "../headings";

// #313: a hover 🔗 on every heading LINE of a CM surface (member view/edit, guest) that copies the
// heading's anchor URL (GitHub-style slug — the SAME slugify the TOC and the public reader use, so
// one anchor resolves on every surface). Built as a Decoration.widget at the heading line's end —
// NOT the tooltip layer: this is per-line persistent chrome (like the fence header's copy button),
// display-only and offset-invariant, revealed by CSS on line hover with zero per-mousemove dispatches.
// The copied URL is origin+pathname only (never ?edit=1 / ?diff= — an anchor must not force a mode).

// Lucide link glyph (trusted constant — shared with the public-reader DOM variant). Sized in em
//: the icon follows the HEADING's font size (h1 gets a big icon, h6 a small one) instead of
// a fixed 14px. Requires the host button to inherit the heading's font-size (both surfaces do).
export const HEADING_LINK_ICON = '<svg width="0.8em" height="0.8em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

export function headingAnchorUrl(slug: string): string {
  return `${window.location.origin}${window.location.pathname}#${encodeURIComponent(slug)}`;
}

class HeadingAnchorWidget extends WidgetType {
  constructor(readonly slug: string) { super(); }
  // Stable-key eq (the widget-churn lesson): same slug ⇒ same widget, no DOM rebuild per render.
  eq(other: HeadingAnchorWidget): boolean { return other.slug === this.slug; }
  toDOM(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-lp-heading-anchor";
    btn.setAttribute("aria-label", i18n.t("toc.copyAnchor"));
    btn.title = i18n.t("toc.copyAnchor");
    btn.setAttribute("data-testid", "heading-anchor-copy");
    btn.dataset.slug = this.slug;
    btn.innerHTML = HEADING_LINK_ICON; // trusted constant SVG — no user input
    // #265 guard: interactive DOM inside a CM widget must stopPropagation mousedown (not rely on
    // ignoreEvent alone), so a click never moves the caret / steals the selection on the edit surface.
    btn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void navigator.clipboard?.writeText(headingAnchorUrl(this.slug))
        .then(() => notify.success(i18n.t("toast.copied")))
        .catch(() => { /* clipboard denied (insecure ctx / permission) — no-op */ });
    });
    return btn;
  }
  ignoreEvent(): boolean { return true; }
}

function buildDecos(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const h of extractHeadings(view.state)) {
    const lineTo = view.state.doc.lineAt(h.from).to;
    b.add(lineTo, lineTo, Decoration.widget({ widget: new HeadingAnchorWidget(h.slug), side: 1 }));
  }
  return b.finish();
}

const headingAnchorTheme = EditorView.baseTheme({
  ".cm-lp-heading-anchor": {
    opacity: "0",
    border: "none",
    background: "transparent",
    color: "var(--fg-dim, #888)",
    cursor: "pointer",
    padding: "0 0.2em",
    marginLeft: "0.3em",
    //a full 1em icon on the baseline overshot the glyph tops (cap height ≈ 0.7em) and read as "too big
    // and floating above the text". Size it to the cap height (0.8em, ≤ font-size × 0.85) and drop it ~0.1em so
    // its top sits at the cap, not above it.
    verticalAlign: "-0.1em",
    transition: "opacity 120ms",
    //a <button> does NOT inherit font by default (UA font: menu), so the em-sized icon would
    // resolve against ~13px regardless of the heading. Inherit the heading line's font-size so the
    // icon scales with h1…h6.
    fontSize: "inherit",
    lineHeight: "1",
  },
  ".cm-line:hover .cm-lp-heading-anchor, .cm-lp-heading-anchor:focus-visible": { opacity: "1" },
  ".cm-lp-heading-anchor:hover": { color: "var(--fg)" },
});

export const headingAnchors: Extension = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = buildDecos(view); }
      update(u: ViewUpdate) {
        // Rebuild on doc edits AND on parse progression (a big doc's tree grows across updates —
        // headings parsed after the first paint must still get their anchor).
        if (u.docChanged || syntaxTree(u.state).length !== syntaxTree(u.startState).length) {
          this.decorations = buildDecos(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  ),
  headingAnchorTheme,
];
