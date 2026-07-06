import { Facet, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { matchTitleLinks, type TitleEntry, type MatchOpts } from "./title-links";

// #224 / ADR-104: render auto internal links over body text whose words match a page title. The decoration is
// DISPLAY-ONLY and OFFSET-INVARIANT (a Mark over the existing text — the source stays plain Markdown, Open
// formats). It carries NO authz: the host injects `titleLinkSource` with a dictionary ALREADY filtered to the
// viewer's authorized pages (search viewer denormalisation) and re-confirms `view` when the link is followed.
// Linkifying a title reveals nothing new — the viewer already sees those pages. The authz burden lives entirely
// on whoever populates the dictionary; this plugin only decorates + routes clicks through the host's navigate.

export interface TitleLinkSource {
  readonly dict: readonly TitleEntry[]; // viewer-authorized {title,pageId} — host's responsibility
  readonly navigate: (pageId: string) => void; // host routes (re-confirms view at the destination)
  readonly opts?: MatchOpts;
}

// Absent/empty source → the plugin is inert (no dictionary → no links). Safe default.
export const titleLinkSource = Facet.define<TitleLinkSource | null, TitleLinkSource | null>({
  combine: (v) => (v.length ? v[v.length - 1]! : null),
});

const titleLinkMark = (pageId: string) =>
  Decoration.mark({ class: "cm-lp-title-link", attributes: { "data-title-link": pageId } });

// Only decorate the visible viewport ranges (large docs stay cheap); matchTitleLinks re-runs per slice.
function buildTitleLinks(view: EditorView): DecorationSet {
  const src = view.state.facet(titleLinkSource);
  if (!src || src.dict.length === 0) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (const m of matchTitleLinks(text, src.dict, src.opts)) {
      ranges.push(titleLinkMark(m.pageId).range(from + m.from, from + m.to));
    }
  }
  return Decoration.set(ranges, true);
}

// A click on a rendered title link routes through the host's navigate (which re-confirms view at the target).
// Uses a single delegated listener on the editor DOM; never navigates on its own (no hardcoded routing).
export function titleLinkDecorations(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildTitleLinks(view);
      }
      update(u: ViewUpdate) {
        const srcChanged = u.startState.facet(titleLinkSource) !== u.state.facet(titleLinkSource);
        if (u.docChanged || u.viewportChanged || srcChanged) this.decorations = buildTitleLinks(u.view);
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e, view) {
          const t = e.target as HTMLElement | null;
          const el = t?.closest?.(".cm-lp-title-link") as HTMLElement | null;
          if (!el) return false;
          const pageId = el.getAttribute("data-title-link");
          const src = view.state.facet(titleLinkSource);
          if (!pageId || !src) return false;
          e.preventDefault();
          src.navigate(pageId);
          return true;
        },
      },
    },
  );
}
