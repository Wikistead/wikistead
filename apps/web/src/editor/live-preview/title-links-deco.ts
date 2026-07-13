import { Facet, StateEffect, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, hoverTooltip } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { matchTitleLinks, type TitleEntry, type MatchOpts } from "./title-links";

// #224 / ADR-104: render auto internal links over body text whose words match a page title. The decoration is
// DISPLAY-ONLY and OFFSET-INVARIANT (a Mark over the existing text — the source stays plain Markdown, Open
// formats). It carries NO authz: the host injects `titleLinkSource` with a dictionary ALREADY filtered to the
// viewer's authorized pages (the viewer-scoped dictionary endpoint) and re-confirms `view` when the link is
// followed / its excerpt is fetched. Linkifying a title reveals nothing new — the viewer already sees those
// pages. The authz burden lives entirely on whoever populates the dictionary; this plugin only decorates,
// shows the hover card, and routes clicks through the host's navigate.

export interface TitleLinkSource {
  // viewer-authorized {title,pageId} — host's responsibility. May be a live getter (the host mutates the
  // backing array on refetch/invalidation and dispatches titleLinksRefresh to redecorate).
  readonly dict: readonly TitleEntry[];
  readonly navigate: (pageId: string) => void; // host routes (the destination re-confirms view — uniform 404)
  // #224 Slice B: the hover-card excerpt — a HOST fetch that re-confirms `view` at display time (the
  // authoritative check). null result → empty card body. Absent → no hover card at all.
  readonly excerpt?: (pageId: string) => Promise<{ title: string; excerpt: string | null } | null>;
  readonly opts?: MatchOpts;
}

// Absent/empty source → the plugin is inert (no dictionary → no links). Safe default.
export const titleLinkSource = Facet.define<TitleLinkSource | null, TitleLinkSource | null>({
  combine: (v) => (v.length ? v[v.length - 1]! : null),
});

// #224 (security-timing): the host dispatches this after mutating its dictionary (refetch after an
// invalidation ping / TTL refresh) so stale colored links disappear WITHOUT a doc/viewport change.
export const titleLinksRefresh = StateEffect.define<null>();

const titleLinkMark = (pageId: string) =>
  Decoration.mark({ class: "cm-lp-title-link", attributes: { "data-title-link": pageId } });

// #350: the explicit-markdown link/image ranges (`[text](url)` / `![alt](url)`) — an auto title-link must NOT
// overlay them. `matchTitleLinks` only sees plain text and would linkify a `[]/p/x)` whose LABEL
// happens to equal a page title, stacking a second (possibly different-target) link + hover card on a hand-
// written one (and contradicting a #276 struck-through dead link). Collect the Link/Image node ranges from the
// shared Lezer tree (like dead-links.ts) and drop any auto-match that overlaps one. This only SHRINKS the
// auto-link set, so it adds no authz surface (the viewer dictionary / view re-confirm are untouched).
function collectLinkRanges(view: EditorView, from: number, to: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  syntaxTree(view.state).iterate({
    from, to,
    enter: (node) => { if (node.name === "Link" || node.name === "Image") out.push({ from: node.from, to: node.to }); },
  });
  return out;
}

// Only decorate the visible viewport ranges (large docs stay cheap); matchTitleLinks re-runs per slice.
function buildTitleLinks(view: EditorView): DecorationSet {
  const src = view.state.facet(titleLinkSource);
  if (!src || src.dict.length === 0) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    const links = collectLinkRanges(view, from, to);
    for (const m of matchTitleLinks(text, src.dict, src.opts)) {
      const mFrom = from + m.from, mTo = from + m.to;
      if (links.some((l) => mFrom < l.to && mTo > l.from)) continue; // #350: skip — inside an explicit link/image
      ranges.push(titleLinkMark(m.pageId).range(mFrom, mTo));
    }
  }
  return Decoration.set(ranges, true);
}

// Module-scope plugin handle so the hover tooltip reads the ACTUAL rendered link ranges (never a
// re-derivation that could disagree with what is on screen). A click routes through the host's
// navigate (which re-confirms view at the target); never navigates on its own (no hardcoded routing).
const titleLinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildTitleLinks(view);
    }
    update(u: ViewUpdate) {
      const srcChanged = u.startState.facet(titleLinkSource) !== u.state.facet(titleLinkSource);
      const refreshed = u.transactions.some((tr) => tr.effects.some((e) => e.is(titleLinksRefresh)));
      if (u.docChanged || u.viewportChanged || srcChanged || refreshed) this.decorations = buildTitleLinks(u.view);
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

export function titleLinkDecorations(): Extension {
  return titleLinkPlugin;
}

// #224: the hover card — title + a plain-text excerpt fetched through the HOST seam (the server
// re-confirms `view`; deny/missing are one uniform 404, so the card just stays empty — no oracle).
// Rendered in the CM TOOLTIP layer (the floating-UI rule: persistent DOM outside the tooltip layer
// gets reconciled away). The excerpt is set via textContent ONLY — never parsed/injected as markup.
const titleLinkCardTheme = EditorView.baseTheme({
  ".cm-lp-title-link-card": {
    maxWidth: "22rem",
    padding: "0.5em 0.7em",
    fontSize: "0.85em",
    lineHeight: "1.45",
  },
  ".cm-lp-title-link-card-title": { fontWeight: "700", marginBottom: "0.25em" },
  ".cm-lp-title-link-card-body": {
    color: "var(--fg-dim, #888)",
    whiteSpace: "pre-wrap",
    display: "-webkit-box",
    "-webkit-line-clamp": "6",
    "-webkit-box-orient": "vertical",
    overflow: "hidden",
    overflowWrap: "anywhere",
  },
});

export function titleLinkHover(): Extension {
  return [
    hoverTooltip((view, pos) => {
      const src = view.state.facet(titleLinkSource);
      if (!src?.excerpt) return null;
      const plugin = view.plugin(titleLinkPlugin);
      if (!plugin) return null;
      let found: { from: number; to: number; pageId: string } | null = null;
      plugin.decorations.between(pos, pos, (from, to, deco) => {
        const id = (deco.spec as { attributes?: Record<string, string> }).attributes?.["data-title-link"];
        if (id) {
          found = { from, to, pageId: id };
          return false;
        }
      });
      if (!found) return null;
      const hit: { from: number; to: number; pageId: string } = found;
      return {
        pos: hit.from,
        end: hit.to,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "cm-lp-title-link-card";
          dom.setAttribute("data-testid", "title-link-card");
          const title = document.createElement("div");
          title.className = "cm-lp-title-link-card-title";
          const entry = src.dict.find((d) => d.pageId === hit.pageId);
          title.textContent = entry?.title ?? "";
          const body = document.createElement("div");
          body.className = "cm-lp-title-link-card-body";
          dom.append(title, body);
          void src
            .excerpt!(hit.pageId)
            .then((r) => {
              if (r?.title) title.textContent = r.title;
              body.textContent = r?.excerpt ?? ""; // textContent only — no injection surface
            })
            .catch(() => {
              body.textContent = ""; // denied/missing → uniform empty card (no oracle)
            });
          return { dom };
        },
      };
    }),
    titleLinkCardTheme,
  ];
}
