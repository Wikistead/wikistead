import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { connect } from "./collab";
import { mountSource } from "./editor-source";
import { mountLivePreview } from "./editor-livepreview";
import { makeImageResolver } from "./image-resolver";
import styles from "./Editor.module.css";

// Awareness type derived from the provider so we don't take a direct dependency
// on y-protocols just for a type.
type Awareness = NonNullable<ReturnType<typeof connect>["provider"]["awareness"]>;

export interface EditorUser {
  name: string;
  color: string;
}

export type EditorCapability = "view" | "edit";

// Three display states (P3). Default is "view" for everyone — readers are the
// majority. An edit-capable user reveals the editable surfaces on demand:
//   view  → single preview pane, read-only (still receives remote edits + carets)
//   edit  → single preview pane, editable
//   split → source (vim) + preview, editable
type Mode = "view" | "edit" | "split";

export interface EditorProps {
  docName: string;
  token: string; // collab WebSocket token
  collabUrl: string;
  user: EditorUser;
  // Edit gate (UI only — the collab server is the fortress; see below). Defaults
  // to view so an unresolved/forbidden page is never editable.
  capability?: EditorCapability;
  // API auth for image resolution (dev-token bearer, or "" for the cookie session)
  // — distinct from the collab token above. Omit for guests (images won't resolve).
  apiToken?: string;
}

function userField(user: EditorUser) {
  return { name: user.name, color: user.color, colorLight: `${user.color}33` };
}

// React wrapper around the CodeMirror surfaces. TWO independent lifecycles
// (ADR-013 isolation invariant, extended for P3):
//
//   1. COLLAB connection — keyed on (docName, token, collabUrl). Owns the
//      provider / Y.Doc / WebSocket / awareness. Mode changes do NOT touch it, so
//      toggling view↔edit↔split never reconnects, never drops presence, never
//      leaves a ghost cursor. Only a page (docName) switch rebuilds it.
//   2. SURFACE views — keyed additionally on the mode. Mounts/destroys the CM
//      view(s) onto the SAME canonical Y.Text. Effects run in declaration order
//      within a commit, so on a docName switch the collab effect reconnects first
//      and the surface effect then mounts against the fresh connection.
//
// The two-layer edit defense: this component hides the editable surfaces for a
// view-only capability, but that is convenience. The collab server re-derives
// readOnly from OpenFGA per document, so a forged edit button still cannot write.
export function Editor({ docName, token, collabUrl, user, capability = "view", apiToken = "" }: EditorProps) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const collabRef = useRef<ReturnType<typeof connect> | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);

  const [mode, setMode] = useState<Mode>("view");
  // A view-only capability can never leave view mode (the controls aren't
  // rendered, and this guarantees it even if some state went stale).
  const effectiveMode: Mode = capability === "edit" ? mode : "view";

  // Resolves wks-attachment image ids to fresh presigned URLs (TTL-cached). Bound
  // to the API token (cookie/dev-token), rebuilt only when it changes.
  const resolveImageUrl = useMemo(() => makeImageResolver(apiToken), [apiToken]);

  // Dev-only probe for the isolation invariant (ADR-013): editor content is not in
  // React state, so typing must NOT re-render this component (read before/after).
  if (import.meta.env.DEV) {
    (window as unknown as { __editorRenders?: number }).__editorRenders =
      ((window as unknown as { __editorRenders?: number }).__editorRenders ?? 0) + 1;
  }

  // (1) Collab connection — survives mode toggles.
  useLayoutEffect(() => {
    const c = connect({ url: collabUrl, docName, token });
    collabRef.current = c;
    awarenessRef.current = c.provider.awareness ?? null;
    c.provider.awareness?.setLocalStateField("user", userField(user));
    return () => {
      c.disconnect();
      collabRef.current = null;
      awarenessRef.current = null;
    };
    // user intentionally excluded — presence updates go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docName, token, collabUrl]);

  // (2) Surfaces — remount on mode change (same connection) or after a reconnect.
  useLayoutEffect(() => {
    const c = collabRef.current;
    if (!c) return;
    const editable = effectiveMode !== "view";
    const sourceHost = sourceRef.current;
    const previewHost = previewRef.current!;

    const views: { destroy(): void }[] = [];
    if (effectiveMode === "split" && sourceHost) {
      views.push(mountSource(sourceHost, c.ytext, c.provider, { readOnly: false }));
    }
    views.push(mountLivePreview(previewHost, c.ytext, c.provider, { readOnly: !editable, resolveImageUrl }));

    return () => {
      views.forEach((v) => v.destroy());
      sourceHost?.replaceChildren();
      previewHost.replaceChildren();
    };
  }, [docName, token, collabUrl, effectiveMode, resolveImageUrl]);

  // Presence label changes must NOT rebuild the editors — just update awareness.
  useEffect(() => {
    awarenessRef.current?.setLocalStateField("user", userField(user));
  }, [user.name, user.color]);

  const canEdit = capability === "edit";

  return (
    <div className={styles.editor} data-mode={effectiveMode}>
      <section className={styles.pane} data-pane="source" hidden={effectiveMode !== "split"}>
        <h2 className={styles.paneTitle}>source (vim)</h2>
        <div ref={sourceRef} className={styles.host} />
      </section>
      <section className={styles.pane} data-pane="preview">
        {canEdit && (
          <div className={styles.modeBar} data-testid="editor-modebar">
            {effectiveMode === "view" ? (
              <button type="button" data-testid="edit-toggle" onClick={() => setMode("edit")}>Edit</button>
            ) : (
              <>
                <button type="button" data-testid="source-toggle" onClick={() => setMode(effectiveMode === "split" ? "edit" : "split")}>
                  {effectiveMode === "split" ? "Hide source" : "Source (vim)"}
                </button>
                <button type="button" data-testid="view-toggle" onClick={() => setMode("view")}>Done</button>
              </>
            )}
          </div>
        )}
        <div ref={previewRef} className={styles.host} />
      </section>
    </div>
  );
}
