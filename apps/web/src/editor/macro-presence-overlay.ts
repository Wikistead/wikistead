import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import * as Y from "yjs";
import { ySyncFacet } from "y-codemirror.next";
import { livePreview, macroPresence } from "./live-preview/decorations";
import { initials } from "../ui/avatar";

// #92 comment 982 (②③): macro-presence as an OUTLINE + top-right avatar overlay, generalised to EVERY
// macro block. Replaces the old "(name) editing" badge (block widget above the macro) that overlapped the
// ✎/Ctrl+↵ button and only covered the Excalidraw modal case.
//
// PRESENCE-SAFE BY CONSTRUCTION (same contract as remote-cursors.ts): an ADDITIVE, read-only overlay in
// its own DOM layer. It NEVER dispatches into CM, never writes awareness, never touches doc/offset/sync —
// so it cannot re-break yCollab cursor sync (the #92 regression that broke it twice was a re-entrant
// dispatch inside the awareness "change" handler). yCollab already dispatches a transaction on every remote
// awareness change, so this plugin's update() re-runs in lockstep; positioning happens in a measure phase.
//
// Two presence sources, unified per macro block:
//   (a) macroEdit — a peer with a macro's MODAL/editUI open (they left the page surface, so their page
//       caret vanished): published on the page awareness as `macroEdit=<block from>` (macro-presence.ts).
//   (b) remote caret — a peer whose page caret/selection head sits ON a macro atom (livePreview.blocks):
//       read from yCollab awareness exactly as remote-cursors does (offset-critical mapping reused).

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

interface Rect { readonly top: number; readonly left: number; readonly width: number; readonly height: number; readonly peers: OverlayPeer[] }

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
      const contentRect = view.contentDOM.getBoundingClientRect();
      const out: Rect[] = [];
      for (const b of blocks) {
        const peers = byBlock.get(b.from);
        if (!peers || !peers.length) continue;
        const to = Math.min(b.to, view.state.doc.length);
        const a = view.coordsAtPos(b.from, 1);
        const z = view.coordsAtPos(to, -1);
        if (!a || !z) continue;
        out.push({
          top: a.top - layerRect.top,
          left: contentRect.left - layerRect.left,
          width: contentRect.width,
          height: Math.max(z.bottom - a.top, 12),
          peers,
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
        box.className = "cm-macro-presence-box";
        box.setAttribute("data-testid", "macro-presence");
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
          chip.title = p.name;
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
  // The macro-wide outline in the peer's colour (offset-invariant — display only; the box owns no text).
  ".cm-macro-presence-box": {
    position: "absolute",
    boxSizing: "border-box",
    border: "2px solid var(--mp-color, #30bced)",
    borderRadius: "6px",
    pointerEvents: "none",
  },
  // Avatar stack in the TOP-RIGHT corner — deliberately opposite the ✎/Ctrl+↵ edit button (top-left) so
  // the two never overlap (#92 comment 982 ②).
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
