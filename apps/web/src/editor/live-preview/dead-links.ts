import { syntaxTree } from "@codemirror/language";
import { StateEffect, type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { linkHref, linkStatusResolver } from "./decorations";

// #276 / ADR-117: a dead INTERNAL link (`[text](/p/<id>)` whose target the viewer can't view — deleted,
// private, other-space, cross-tenant, or never existed) is rendered struck-through so a reader sees it is
// dead before clicking. Display-only overlay — the body is never rewritten (Open formats) and the link
// stays clickable (→ the #262 unified not-found on click). authz: "dead" is a pure VIEWABILITY answer from
// the host (existence-hiding — deny and missing are identical, #262); the client never learns which.

const INTERNAL_LINK_RE = /^\/p\/([^/?#]+)/; // an internal page link target → capture the id (strip query/hash)
const deadMark = Decoration.mark({ class: "cm-lp-link-dead", attributes: { title: "Link target not found" } });

// Collect the doc's internal `/p/<id>` link ranges from the SYNTAX TREE — the SAME Lezer `Link` nodes and
// `linkHref` sanitizer the `cm-lp-link` mark emits from (decorations.ts), so the dead overlay and the link
// body derive from one source of truth and can never disagree. External URLs (http/https/mailto) and
// attachment links (`wks-attachment:`) yield a non-`/p/` href or null → excluded. #224 title auto-links are
// display-only marks (no Link node) and are viewer-scoped by construction, so they never appear here.
// Exported for unit testing.
export function collectInternalLinks(state: EditorState): { from: number; to: number; id: string }[] {
  const out: { from: number; to: number; id: string }[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Link") return;
      const href = linkHref(state.doc.sliceString(node.from, node.to));
      if (!href) return;
      const m = INTERNAL_LINK_RE.exec(href);
      if (m) out.push({ from: node.from, to: node.to, id: m[1]! });
    },
  });
  return out;
}

// Fired when a batch resolves, so the plugin re-runs its decoration build with the freshly-known dead ids.
const bumpDeadLinks = StateEffect.define<null>();

// The overlay plugin. It maintains a per-id viewability cache (resolved once, reused across edits), lays a
// SECOND `cm-lp-link-dead` mark over any link whose target resolved as NOT viewable, and batch-fetches the
// unknowns via the host seam. Offset-invariant (marks never touch the doc → single Y.Text / remote carets
// unaffected). One plugin serves BOTH the Live editing surface and the read-only Reading/published view.
class DeadLinkPlugin {
  decorations: DecorationSet = Decoration.none;
  #known = new Map<string, boolean>(); // id → viewable (true = alive, false = dead)
  #pending = new Set<string>();
  constructor(readonly view: EditorView) {
    this.decorations = this.build();
    this.fetchUnknown();
  }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(bumpDeadLinks)))) {
      this.decorations = this.build();
      this.fetchUnknown();
    }
  }
  build(): DecorationSet {
    const decos = [];
    for (const l of collectInternalLinks(this.view.state)) {
      if (this.#known.get(l.id) === false) decos.push(deadMark.range(l.from, l.to)); // known-dead only
    }
    return Decoration.set(decos, true);
  }
  fetchUnknown() {
    const resolve = this.view.state.facet(linkStatusResolver);
    if (!resolve) return; // no host seam (guest/picker-less surface) → nothing is struck
    const ids = new Set<string>();
    for (const l of collectInternalLinks(this.view.state)) {
      if (!this.#known.has(l.id) && !this.#pending.has(l.id)) ids.add(l.id);
    }
    if (!ids.size) return;
    const batch = [...ids];
    batch.forEach((id) => this.#pending.add(id));
    void resolve(batch).then((viewable) => {
      batch.forEach((id) => this.#pending.delete(id));
      if (!viewable) return; // could not resolve → leave every link ALIVE (never a false "dead")
      for (const id of batch) this.#known.set(id, viewable.has(id));
      try { this.view.dispatch({ effects: bumpDeadLinks.of(null) }); } catch { /* view torn down mid-fetch */ }
    });
  }
}

export const deadLinks = ViewPlugin.fromClass(DeadLinkPlugin, { decorations: (v) => v.decorations });
