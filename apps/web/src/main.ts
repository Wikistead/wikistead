import { connect } from "./collab";
import { mountSource } from "./editor-source";
import { mountLivePreview } from "./editor-livepreview";

// PoC wiring. Token + docName would come from the app/share-link flow.
const url = (import.meta as any).env?.VITE_COLLAB_URL ?? "ws://localhost:4100";
const token = (import.meta as any).env?.VITE_TOKEN ?? "dev-token";
const docName = (import.meta as any).env?.VITE_DOC ?? "t:tenant_dev:p:demo";

const { ytext, provider } = connect({ url, docName, token });

// Label this client's presence. yCollab reads awareness `user` ({ name, color,
// colorLight }) to render the remote caret + name tag. Because both surfaces
// share this one awareness, a collaborator's caret appears on BOTH panes.
const palette = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080"];
const color = palette[Math.floor(Math.random() * palette.length)];
provider.awareness?.setLocalStateField("user", {
  name: `anon-${Math.floor(Math.random() * 1000)}`,
  color,
  colorLight: `${color}33`,
});

mountSource(document.getElementById("source")!, ytext, provider);
mountLivePreview(document.getElementById("preview")!, ytext, provider);
