import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

// docName must match the server: "t:<tenantId>:p:<pageId>".
// token is either a member OIDC token or an app-issued guest share token —
// the SAME collab server endpoint accepts both (see apps/collab).
export function connect(opts: { url: string; docName: string; token: string }) {
  const doc = new Y.Doc();
  // Create the WebSocket transport explicitly. When HocuspocusProvider is given
  // a `url` it auto-creates an internal websocket that `provider.destroy()` does
  // NOT close (destroy only detaches the document provider) — leaking a socket
  // that keeps reconnecting on every page switch. Owning the socket lets the
  // caller close it in disconnect() below.
  const socket = new HocuspocusProviderWebsocket({ url: opts.url });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: opts.docName,
    document: doc,
    token: opts.token,
  });
  // SINGLE canonical CRDT type. Both surfaces bind to this same Y.Text — no
  // XmlFragment, no bridging. This is what makes cross-surface presence trivial.
  const ytext = doc.getText("content");

  // Full teardown: drop presence first (no ghost cursor), detach the document
  // provider, AND close the underlying socket (no WS leak), then free the doc.
  // Robust to rapid page switches and React StrictMode double-mounts.
  const disconnect = () => {
    try {
      provider.awareness?.setLocalState(null);
    } catch {
      /* awareness already gone */
    }
    provider.destroy();
    socket.destroy();
    doc.destroy();
  };

  return { doc, provider, socket, ytext, disconnect };
}

// #92 / ADR-093: an EPHEMERAL collab session for level-2 Excalidraw co-editing. Connects to the
// page's ephemeral room `t:<tenant>:p:<pageId>:x:<anchor>` (the collab server admits it with the same
// page-EDIT authority and NEVER persists it — the scene is flushed to the fence on close). Returns a
// fresh Y.Doc (scene lives in a Y.Map, not the page Y.Text) + awareness (who's drawing) + a destroy().
// This is a HOST-provided seam (the excalidraw macro receives it, keeping MacroContext={theme} narrow).
export interface EphemeralSession {
  doc: Y.Doc;
  awareness: HocuspocusProvider["awareness"];
  destroy: () => void;
}
export function connectEphemeral(opts: { url: string; docName: string; anchor: string; token: string }): EphemeralSession {
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: opts.url });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: `${opts.docName}:x:${opts.anchor}`, // the ephemeral room (server: parseDocName ⇒ ephemeral)
    document: doc,
    token: opts.token,
  });
  const destroy = () => {
    try { provider.awareness?.setLocalState(null); } catch { /* gone */ }
    provider.destroy();
    socket.destroy();
    doc.destroy();
  };
  return { doc, awareness: provider.awareness, destroy };
}
