import { connect } from "./collab";
import { mountSource } from "./editor-source";
import { mountPreview } from "./editor-preview";

// PoC wiring. Token + docName would come from the app/share-link flow.
const url = (import.meta as any).env?.VITE_COLLAB_URL ?? "ws://localhost:4100";
const token = (import.meta as any).env?.VITE_TOKEN ?? "dev-token";
const docName = (import.meta as any).env?.VITE_DOC ?? "t:tenant_dev:p:demo";

const { ytext, provider } = connect({ url, docName, token });
mountSource(document.getElementById("source")!, ytext, provider);
mountPreview(document.getElementById("preview")!, ytext);
