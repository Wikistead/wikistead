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
export function collectInternalLinks(
  state: EditorState,
  // #755 / ADR-241 decision 2: which part of the doc to look at. Omitted = the whole thing, which is what
  // the decoration build wants (it lays marks over what it already knows). The FETCH passes the viewport,
  // because a link the reader cannot see does not need an answer yet.
  ranges?: readonly { from: number; to: number }[],
): { from: number; to: number; id: string }[] {
  const out: { from: number; to: number; id: string }[] = [];
  const seen = new Set<number>(); // a Link straddling two ranges is entered twice; keyed by start offset
  const enter = (node: { name: string; from: number; to: number }) => {
    if (node.name !== "Link") return;
    if (seen.has(node.from)) return;
    const href = linkHref(state.doc.sliceString(node.from, node.to));
    if (!href) return;
    const m = INTERNAL_LINK_RE.exec(href);
    if (m) { seen.add(node.from); out.push({ from: node.from, to: node.to, id: m[1]! }); }
  };
  if (!ranges) syntaxTree(state).iterate({ enter });
  else for (const r of ranges) syntaxTree(state).iterate({ from: r.from, to: r.to, enter });
  return out;
}

// #755 / ADR-241 decision 2 + the truncation it uncovered. Which ids to put in the next request.
//
// Two jobs, and the second one is a bug fix. The obvious one: never re-ask for an id already answered or
// already in flight. The other: NEVER SEND MORE THAN THE SERVER WILL ANSWER. `/pages/link-status` caps the
// list at MAX_LINK_STATUS_IDS and silently drops the rest, and the caller then reads every id it sent as
// answered — so an id past the cap came back absent, and absent is how this overlay spells "dead". A
// document with more internal links than the cap struck through the ones past it, all of them alive.
//
// Exported and pure so the cap and the de-dup are measurable without a laid-out editor.
export function planLinkStatusRequest(
  candidates: readonly { id: string }[],
  known: ReadonlyMap<string, boolean>,
  pending: ReadonlySet<string>,
  cap: number,
): string[] {
  const batch: string[] = [];
  const taken = new Set<string>();
  for (const c of candidates) {
    if (batch.length >= cap) break;
    if (known.has(c.id) || pending.has(c.id) || taken.has(c.id)) continue;
    taken.add(c.id);
    batch.push(c.id);
  }
  return batch;
}

// Mirrors MAX_LINK_STATUS_IDS on the server, and staying under it is THIS side's job.
//
// The route trims an over-long list to its cap and answers 200 without saying it trimmed. The response
// lists the ids the caller may VIEW, so a dead one is absent — and an id the route never looked at is
// absent in exactly the same way. Nothing in the body separates them, which is why the caller must not
// ask for more than will be answered: a document with more internal links than the cap used to wear a
// strike-through on the ones past it, every one of them alive.
//
// That the route trims silently is its own defect and is filed separately; a client that respects the
// cap does not depend on how that is settled.
export const LINK_STATUS_REQUEST_CAP = 256;

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
    // #755 / ADR-241 decision 2: ask about the links the reader can SEE, not every link in the document.
    //
    // Each `view` costs the store far more than the other page relations — it is the one relation that
    // unions the whole capability lattice — and opening a page used to buy an answer for every link at
    // once, including the ones a thousand lines further down that nobody has looked at. The answers are
    // identical either way; this changes WHEN they are asked. The plugin already re-runs on
    // `viewportChanged`, so scrolling asks for the next screenful on its own.
    const batch = planLinkStatusRequest(
      collectInternalLinks(this.view.state, this.view.visibleRanges),
      this.#known, this.#pending, LINK_STATUS_REQUEST_CAP,
    );
    if (!batch.length) return;
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
