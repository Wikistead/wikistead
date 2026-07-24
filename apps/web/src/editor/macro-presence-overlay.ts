import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import * as Y from "yjs";
import { ySyncFacet } from "y-codemirror.next";
import { livePreview, macroPresence, ATOM_BOX_CLASS } from "./live-preview/decorations";
import { islandEditAnchor } from "./live-preview/macro-edit";
import { initials } from "../ui/avatar";

// #92 comment 982 (②③): macro-presence as an OUTLINE + top-right avatar overlay, generalised to EVERY
// macro block. Replaces the old "(name) editing" badge (block widget above the macro) that overlapped the
// ✎/Ctrl+↵ button and only covered the Excalidraw modal case.
//
// PRESENCE-SAFE BY CONSTRUCTION (same contract as remote-cursors.ts): an ADDITIVE, read-only overlay in
// its own DOM layer. It NEVER dispatches into CM, never writes awareness, never touches doc/offset/sync
// so it cannot re-break yCollab cursor sync (the #92 regression that broke it twice was a re-entrant
// dispatch inside the awareness "change" handler). yCollab already dispatches a transaction on every remote
// awareness change, so this plugin's update re-runs in lockstep; positioning happens in a measure phase.
//
// Two presence sources, unified per macro block
// (a) macroEdit — a peer with a macro's MODAL/editUI open (they left the page surface, so their page
// caret vanished): published on the page awareness as `macroEdit=<block from>` (macro-presence.ts).
// (b) remote caret — a peer whose page caret/selection head sits ON a macro atom (livePreview.blocks)
// read from yCollab awareness exactly as remote-cursors does (offset-critical mapping reused).

export interface BlockRange { readonly from: number; readonly to: number }
export interface OverlayPeer { readonly name: string; readonly color: string; readonly picture?: string | null; readonly key: string }
export interface ModalPeer { readonly anchor: string; readonly name: string; readonly color: string }
export interface CaretPeer { readonly head: number; readonly name: string; readonly color: string; readonly picture?: string | null }

// Pure: fold both presence sources onto the macro block they occupy → block.from → peers (deduped by
// identity so a peer who both opened the modal AND has a caret in the same block shows one avatar). Unit-
// tested without a DOM. A modal anchor maps to the block whose `from` equals it (else the block that
// CONTAINS it, drift-tolerant); a caret maps to the block whose range contains its head.
export function resolvePresenceBlocks(
  modal: readonly ModalPeer[],
  carets: readonly CaretPeer[],
  blocks: readonly BlockRange[],
): Map<number, OverlayPeer[]> {
  const out = new Map<number, OverlayPeer[]>();
  const add = (from: number, peer: OverlayPeer) => {
    let arr = out.get(from);
    if (!arr) { arr = []; out.set(from, arr); }
    if (!arr.some((p) => p.key === peer.key)) arr.push(peer);
  };
  for (const m of modal) {
    const anchor = Number(m.anchor);
    if (!Number.isFinite(anchor)) continue;
    const block = blocks.find((b) => b.from === anchor) ?? blocks.find((b) => b.from <= anchor && anchor <= b.to);
    if (block) add(block.from, { name: m.name, color: m.color, key: `${m.name}:${m.color}` });
  }
  for (const c of carets) {
    const block = blocks.find((b) => b.from <= c.head && c.head <= b.to);
    if (block) add(block.from, { name: c.name, color: c.color, picture: c.picture, key: `${c.name}:${c.color}` });
  }
  return out;
}

// Read the remote page carets (head offset + identity) from yCollab awareness — the SAME remote-position
// math yCollab/remote-cursors use (createAbsolutePositionFromRelativePosition), so a bug here can at most
// mispose a cosmetic outline; it can never break a caret or the connection.
function remoteCaretPeers(view: EditorView): CaretPeer[] {
  const conf = view.state.facet(ySyncFacet) as
    | { ytext: Y.Text; awareness: { getStates(): Map<number, Record<string, unknown>>; doc: { clientID: number } } }
    | undefined;
  if (!conf) return [];
  const { ytext, awareness } = conf;
  const ydoc = ytext.doc;
  if (!ydoc || !awareness) return [];
  const out: CaretPeer[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.doc.clientID) return; // exclude self
    const cursor = state["cursor"] as { head?: unknown } | undefined;
    if (cursor?.head == null) return;
    const head = Y.createAbsolutePositionFromRelativePosition(cursor.head as Y.RelativePosition, ydoc);
    if (head == null || head.type !== ytext) return;
    const u = (state["user"] as { name?: string; color?: string; picture?: string | null }) || {};
    out.push({ head: head.index, name: String(u.name ?? "Anonymous"), color: String(u.color ?? "#30bced"), picture: u.picture ?? null });
  });
  return out;
}

// `chipOnly` = draw the avatar(s) WITHOUT the outline ring. Used when the observer has no rendered
// atom-box for the peer's macro (they locally raw-expanded it / opened its editUI island), so there is
// no compact widget to ring — an outline would balloon to the full content width (the #453
// ). The peer stays visible as an avatar anchored at the macro's start instead.
interface Rect { readonly top: number; readonly left: number; readonly width: number; readonly height: number; readonly peers: OverlayPeer[]; readonly chipOnly?: boolean }

const macroPresenceOverlayPlugin = ViewPlugin.fromClass(
  class {
    layer: HTMLElement;
    constructor(view: EditorView) {
      this.layer = document.createElement("div");
      this.layer.className = "cm-macro-presence-layer";
      this.layer.setAttribute("aria-hidden", "true");
      view.scrollDOM.appendChild(this.layer);
      this.schedule(view);
    }
    update(u: ViewUpdate) { this.schedule(u.view); }
    schedule(view: EditorView) {
      view.requestMeasure({ key: this, read: () => this.read(view), write: (rects) => this.write(rects) });
    }
    // READ phase: resolve occupied blocks → screen rectangles (coords are re-read against the layer's own
    // rect every frame, so scrolling — which fires an update — self-corrects regardless of the layer's
    // positioning context).
    read(view: EditorView): Rect[] {
      const pres = view.state.facet(macroPresence);
      const modal = pres ? pres.peers() : [];
      const carets = remoteCaretPeers(view);
      if (!modal.length && !carets.length) return [];
      const blocks = view.state.field(livePreview, false)?.blocks ?? [];
      if (!blocks.length) return [];
      const byBlock = resolvePresenceBlocks(modal, carets, blocks);
      if (!byBlock.size) return [];
      const layerRect = this.layer.getBoundingClientRect();
      // #453: hug the MACRO'S OWN rect (the same box the local atom-sel ring wraps) instead of the
      // full content width — the local and remote frames must be the same size and shape. Boxes are
      // matched geometrically per measure (top ≈ block top, height closest to the block height
      // robust against nested boxes inside layout containers), so upstream edits can't leave a
      // stale offset mapping.
      // this asked for `.cm-lp-macro-wrap`, which is only SOME of the roots that take the ring.
      // A callout, a details block and a table each ring on their own root, so a peer's box around them
      // fell through to the full content width — 740px drawn around a 692px callout, and around a 153px
      // table. Ask for the shared marker every ring-taking root wears instead, so this cannot drift out
      // of step with the ring again. A block with no marked root at all keeps the full-width fallback
      // there is no local ring there either, so there is nothing to disagree with.
      const wraps = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(`.${ATOM_BOX_CLASS}`)).map(
        (el) => ({ el, rect: el.getBoundingClientRect() }),
      );
      const out: Rect[] = [];
      for (const b of blocks) {
        const peers = byBlock.get(b.from);
        if (!peers || !peers.length) continue;
        const to = Math.min(b.to, view.state.doc.length);
        const a = view.coordsAtPos(b.from, 1);
        const z = view.coordsAtPos(to, -1);
        if (!a || !z) continue;
        const blockH = Math.max(z.bottom - a.top, 12);
        const candidates = wraps.filter((w) => Math.abs(w.rect.top - a.top) < 8);
        const wrap = candidates.sort(
          (x, y) => Math.abs(x.rect.height - blockH) - Math.abs(y.rect.height - blockH),
        )[0];
        if (wrap) {
          out.push({
            top: wrap.rect.top - layerRect.top,
            left: wrap.rect.left - layerRect.left,
            width: wrap.rect.width,
            height: wrap.rect.height,
            peers,
          });
          continue;
        }
        // #453 no atom-box wrap — the observer has locally raw-expanded this macro (Live per-
        // client reveal) or opened its editUI island, so there is no compact widget to ring. Drawing a
        // full-width outline here is the reported regression (the peer's frame "flies outside" — 740px
        // around a couple of lines / a full-width island). Show the peer as an avatar anchored at the
        // macro's start instead: visible (not vanished), and never a ballooning outline. A tight anchor
        // rect at the block head carries the avatar; `chipOnly` suppresses the ring in the write phase.
        out.push({
          top: a.top - layerRect.top,
          left: a.left - layerRect.left,
          width: 1,
          height: Math.min(blockH, 20),
          peers,
          chipOnly: true,
        });
      }
      return out;
    }
    // WRITE phase: rebuild the overlay children (peers change rarely — a full rebuild is cheap and avoids
    // stale-node bookkeeping). Outline colour = the first peer's colour; every peer gets an avatar chip.
    write(rects: Rect[]) {
      this.layer.replaceChildren();
      for (const r of rects) {
        const box = document.createElement("div");
        box.className = r.chipOnly ? "cm-macro-presence-box cm-macro-presence-box-chip" : "cm-macro-presence-box";
        box.setAttribute("data-testid", "macro-presence");
        if (r.chipOnly) box.setAttribute("data-chip-only", "1");
        box.style.top = `${Math.round(r.top)}px`;
        box.style.left = `${Math.round(r.left)}px`;
        box.style.width = `${Math.round(r.width)}px`;
        box.style.height = `${Math.round(r.height)}px`;
        box.style.setProperty("--mp-color", r.peers[0]!.color);
        const stack = document.createElement("div");
        stack.className = "cm-macro-presence-avatars";
        for (const p of r.peers) {
          const chip = document.createElement("span");
          chip.className = "cm-macro-presence-avatar";
          chip.style.background = p.color;
          chip.dataset.tip = p.name; // #530
          if (p.picture) {
            const img = document.createElement("img");
            img.src = p.picture;
            img.referrerPolicy = "no-referrer";
            img.alt = "";
            img.addEventListener("error", () => { img.remove(); chip.setAttribute("data-initials", initials(p.name)); });
            chip.appendChild(img);
          } else {
            chip.setAttribute("data-initials", initials(p.name));
          }
          stack.appendChild(chip);
        }
        box.appendChild(stack);
        this.layer.appendChild(box);
      }
    }
    destroy() { this.layer.remove(); }
  },
);

const macroPresenceOverlayTheme = EditorView.baseTheme({
  // The layer sits in the scroller with zero footprint; its children are absolutely positioned in the
  // scroller's coordinate space (recomputed each measure, so scroll self-corrects). Never intercepts input.
  ".cm-macro-presence-layer": { position: "absolute", top: "0", left: "0", width: "0", height: "0", pointerEvents: "none", zIndex: "4" },
  // The macro outline in the peer's colour (offset-invariant — display only; the box owns no text).
  // #453: the ring properties are BYTE-IDENTICAL to the local atom-sel ring (.cm-lp-atom-sel,
  // decorations.ts) with only the colour swapped — the box is positioned exactly at the macro
  // wrap's rect, so local and remote frames share one geometry (outline 2px + offset 1px + radius
  // 4px + 22% halo). Keep these two rules in lockstep.
  ".cm-macro-presence-box": {
    position: "absolute",
    boxSizing: "border-box",
    outline: "2px solid var(--mp-color, #30bced)",
    outlineOffset: "1px",
    borderRadius: "4px",
    boxShadow: "0 0 0 5px color-mix(in srgb, var(--mp-color, #30bced) 22%, transparent)",
    pointerEvents: "none",
  },
  // #453 chip-only mode — no ring at all (the observer raw-expanded / opened the editUI island,
  // so there is nothing compact to frame). Only the avatar remains, anchored at the macro's start.
  ".cm-macro-presence-box-chip": { outline: "none", borderRadius: "0", boxShadow: "none" },
  // Avatar stack in the TOP-RIGHT corner — deliberately opposite the ✎/Ctrl+↵ edit button (top-left) so
  // the two never overlap (#92 comment 982 ②). In chip-only mode the box is a 1px anchor at the macro's
  // left, so the avatar sits just past the macro's start (left-aligned) rather than at a far-right edge.
  ".cm-macro-presence-box-chip .cm-macro-presence-avatars": { right: "auto", left: "0" },
  ".cm-macro-presence-avatars": { position: "absolute", top: "-11px", right: "6px", display: "inline-flex", flexDirection: "row-reverse", gap: "0", pointerEvents: "none" },
  ".cm-macro-presence-avatar": {
    width: "20px",
    height: "20px",
    marginLeft: "-6px",
    borderRadius: "50%",
    border: "2px solid var(--panel, #fff)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    color: "#fff",
    fontSize: "9px",
    fontWeight: "700",
    textTransform: "uppercase",
    lineHeight: "1",
    boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
  },
  ".cm-macro-presence-avatar::before": { content: "attr(data-initials)" },
  ".cm-macro-presence-avatar img": { width: "100%", height: "100%", objectFit: "cover", display: "block" },
});

export const macroPresenceOverlay = [macroPresenceOverlayTheme, macroPresenceOverlayPlugin];

// #502 / ADR-184 slice 1: publish the local user's open text-body EDIT-ISLAND anchor (islandEditAnchor)
// onto page awareness, so peers render the #453 occupancy chip for INLINE islands (a revealed macro body,
// a layout slot, a nested editUI island), not only for the Excalidraw MODAL — which already publishes the
// same `macroEdit` field from macro-modal.ts. This is the co-occupancy signal ADR-184's ephemeral-shared-
// doc slices build on.
//
// PRESENCE-SAFE BY CONSTRUCTION (same contract as the overlay above): it only ever writes the ADDITIVE
// `macroEdit` field via macroPresence.set — the SAME field the modal and #453 use — and NEVER touches
// the page Y.Text, yCollab's sync, or the offset path (the #92 re-entrancy regression class). It does not
// fight the modal's publish: it writes ONLY when ITS OWN derived island anchor CHANGES. While a modal owns
// the anchor no island field is set, so this plugin's value stays null and it issues no write — the modal's
// set/clear stands; it clears only the anchor IT published. (The island holds its own doc and commits on
// blur, so typing inside it does not update THIS outer view — the anchor is stable during island editing,
// republished only on enter/leave or a concurrent OUTER edit that shifts the block.)
const macroPresencePublisherPlugin = ViewPlugin.fromClass(
  class {
    published: string | null = null;
    constructor(readonly view: EditorView) { this.sync(view); }
    update(u: ViewUpdate) { this.sync(u.view); }
    sync(view: EditorView) {
      const anchor = islandEditAnchor(view.state);
      if (anchor === this.published) return; // only write on a real transition (never stomp the modal)
      this.published = anchor;
      view.state.facet(macroPresence)?.set(anchor);
    }
    // Tearing the surface down with an island open must not strand a ghost chip on peers. Clearing here is
    // belt-and-braces (the collab disconnect drops all local awareness state); the set is try/caught.
    destroy() { if (this.published !== null) { this.published = null; this.view.state.facet(macroPresence)?.set(null); } }
  },
);

export const macroPresencePublisher = macroPresencePublisherPlugin;
