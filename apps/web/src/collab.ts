import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";

// docName must match the server: "t:<tenantId>:p:<pageId>".
// token is either a member OIDC token or an app-issued guest share token —
// the SAME collab server endpoint accepts both (see apps/collab).
export function connect(opts: { url: string; docName: string; token: string }) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: opts.url,
    name: opts.docName,
    document: doc,
    token: opts.token,
  });
  // SINGLE canonical CRDT type. Both surfaces bind to this same Y.Text — no
  // XmlFragment, no bridging. This is what makes cross-surface presence trivial.
  const ytext = doc.getText("content");
  return { doc, provider, ytext };
}
