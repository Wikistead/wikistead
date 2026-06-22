import { EditorView, ViewPlugin, Decoration, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import * as Y from "yjs";
import { ySyncFacet } from "y-codemirror.next";
import { initials } from "../ui/avatar";

// #8 collaborative cursor avatars + names — the presence showcase.
//
// PRESENCE-SAFE BY CONSTRUCTION. This is an ADDITIVE, read-only overlay layered on
// top of yCollab. yCollab keeps doing everything offset/sync/cleanup-critical: the
// CRDT sync, the caret bar + selection (`.cm-ySelectionCaret`, which foundation.spec
// counts), the ghost-cursor cleanup, undo. We never touch local awareness, the sync
// plugin, or yCollab's decorations. We only READ awareness and draw an always-visible
// avatar+name flag at each remote head, using the SAME remote-position math yCollab
// uses (createAbsolutePositionFromRelativePosition). A bug here can at most mispose a
// cosmetic flag — it can never break a caret or the connection.
//
// We carry NO own awareness listener: yCollab dispatches a transaction on every remote
// awareness change, so our update() re-runs and rebuilds in lockstep — same appear/
// disappear timing, and no dispatch loop (a view transaction emits no awareness event).

interface PresenceUser {
  name?: string;
  color?: string;
  picture?: string | null;
}

class RemoteCursorWidget extends WidgetType {
  constructor(readonly user: PresenceUser) {
    super();
  }
  // Re-create the DOM only when the visible identity changes (not on every keystroke).
  eq(o: RemoteCursorWidget): boolean {
    return o.user.name === this.user.name && o.user.color === this.user.color && o.user.picture === this.user.picture;
  }
  toDOM(): HTMLElement {
    const color = this.user.color || "#30bced";
    const name = this.user.name || "Anonymous";

    // Zero-width inline anchor so the flag floats over the text without shifting it
    // (mirrors how yCollab anchors its caret info).
    const anchor = document.createElement("span");
    anchor.className = "cm-remoteCursorFlag";
    anchor.style.setProperty("--rc-color", color);

    const pill = document.createElement("span");
    pill.className = "cm-remoteCursorPill";

    const av = document.createElement("span");
    av.className = "cm-remoteCursorAvatar";
    if (this.user.picture) {
      // Loaded directly by the browser (no server proxy → no SSRF); fall back to
      // initials if the IdP/CDN URL fails.
      const img = document.createElement("img");
      img.src = this.user.picture;
      img.referrerPolicy = "no-referrer";
      img.alt = "";
      img.addEventListener("error", () => { img.remove(); av.setAttribute("data-initials", initials(name)); });
      av.appendChild(img);
    } else {
      av.setAttribute("data-initials", initials(name));
    }

    const label = document.createElement("span");
    label.className = "cm-remoteCursorName";
    // IMPORTANT: the name + initials are rendered via CSS ::after/::before (content:
    // attr(...)), NOT as real text nodes. A presence flag is not document text, so it
    // must stay invisible to text-node walks (CM offset math in tests, browser
    // find-in-page, innerText extraction) — generated content achieves exactly that.
    label.setAttribute("data-name", name);

    pill.appendChild(av);
    pill.appendChild(label);
    anchor.appendChild(pill);
    return anchor;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const remoteCursorsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    // YSyncConfig (exported via ySyncFacet) carries the same ytext/awareness yCollab uses.
    conf: { ytext: Y.Text; awareness: { getStates: () => Map<number, Record<string, unknown>>; doc: { clientID: number } } } | undefined;

    constructor(view: EditorView) {
      this.conf = view.state.facet(ySyncFacet) as never;
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      this.decorations = this.build(update.view);
    }
    build(_view: EditorView): DecorationSet {
      const conf = this.conf;
      if (!conf) return Decoration.none;
      const ytext = conf.ytext;
      const ydoc = ytext.doc;
      const awareness = conf.awareness;
      if (!ydoc || !awareness) return Decoration.none;
      const decos: Range<Decoration>[] = [];
      awareness.getStates().forEach((state, clientid) => {
        if (clientid === awareness.doc.clientID) return; // skip self
        const cursor = state.cursor as { head?: unknown } | undefined;
        if (cursor == null || cursor.head == null) return;
        // Identical to yCollab's remote handling (the offset-critical mapping).
        const head = Y.createAbsolutePositionFromRelativePosition(cursor.head as Y.RelativePosition, ydoc);
        if (head == null || head.type !== ytext) return;
        const user = (state.user as PresenceUser) || {};
        decos.push(Decoration.widget({ widget: new RemoteCursorWidget(user), side: 1 }).range(head.index));
      });
      return Decoration.set(decos, true);
    }
  },
  { decorations: (v) => v.decorations },
);

// The flag floats above the caret. The avatar is a white chip so initials/picture read
// against the coloured pill; pointer-events off so it never intercepts editor clicks.
const remoteCursorsTheme = EditorView.baseTheme({
  ".cm-remoteCursorFlag": {
    position: "relative",
    display: "inline-block",
    width: "0",
    height: "0",
    verticalAlign: "text-top",
  },
  ".cm-remoteCursorPill": {
    position: "absolute",
    bottom: "0.1em",
    left: "-1px",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    maxWidth: "180px",
    padding: "1px 7px 1px 1px",
    borderRadius: "999px",
    background: "var(--rc-color)",
    color: "#fff",
    fontSize: "11px",
    fontWeight: "600",
    lineHeight: "1.45",
    whiteSpace: "nowrap",
    boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
    pointerEvents: "none",
    userSelect: "none",
    zIndex: "5",
  },
  ".cm-remoteCursorAvatar": {
    width: "15px",
    height: "15px",
    flex: "none",
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    background: "#fff",
    color: "var(--rc-color)",
    fontSize: "8px",
    fontWeight: "700",
    textTransform: "uppercase",
    lineHeight: "1",
  },
  // Generated content (not a text node) so the flag is invisible to text-offset walks.
  ".cm-remoteCursorAvatar::before": {
    content: "attr(data-initials)",
  },
  ".cm-remoteCursorAvatar img": {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  ".cm-remoteCursorName": {
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "150px",
  },
  ".cm-remoteCursorName::after": {
    content: "attr(data-name)",
  },
  // Hide yCollab's own hover-only name label — our flag already shows the name.
  ".cm-ySelectionInfo": {
    display: "none !important",
  },
});

// Drop-in companion to yCollab: add AFTER yCollab in the extensions array.
export const remoteCursors = [remoteCursorsTheme, remoteCursorsPlugin];
