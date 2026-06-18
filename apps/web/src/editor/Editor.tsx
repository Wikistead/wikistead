import { useEffect, useLayoutEffect, useRef } from "react";
import { connect } from "./collab";
import { mountSource } from "./editor-source";
import { mountLivePreview } from "./editor-livepreview";
import styles from "./Editor.module.css";

// Awareness type derived from the provider so we don't take a direct dependency
// on y-protocols just for a type.
type Awareness = NonNullable<ReturnType<typeof connect>["provider"]["awareness"]>;

export interface EditorUser {
  name: string;
  color: string;
}

export interface EditorProps {
  docName: string;
  token: string;
  collabUrl: string;
  user: EditorUser;
  readOnly?: boolean;
}

function userField(user: EditorUser) {
  return { name: user.name, color: user.color, colorLight: `${user.color}33` };
}

// React wrapper around the two CodeMirror surfaces. This is the ONLY place that
// builds and tears down a collab connection (ADR-013 isolation invariant):
//
//  - The editor document lives entirely in Y.Text / CodeMirror and is NEVER put
//    into React state, so parent re-renders never touch the editor subtree
//    (preserves the <16ms local-edit target).
//  - We rebuild only when the collab target (docName/token/collabUrl) changes,
//    not on every render.
//  - Cleanup clears local awareness BEFORE destroying the provider so rapid
//    A->B->A page switches and React StrictMode's double mount/unmount cannot
//    leak a WebSocket or leave a ghost cursor for other collaborators.
export function Editor({ docName, token, collabUrl, user, readOnly }: EditorProps) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const awarenessRef = useRef<Awareness | null>(null);

  // Dev-only probe for the isolation invariant (ADR-013): editor content is not
  // in React state, so typing must NOT re-render this component. The §8
  // verification reads window.__editorRenders before/after typing and asserts it
  // does not change. Stripped from production builds.
  if (import.meta.env.DEV) {
    (window as unknown as { __editorRenders?: number }).__editorRenders =
      ((window as unknown as { __editorRenders?: number }).__editorRenders ?? 0) + 1;
  }

  useLayoutEffect(() => {
    const sourceHost = sourceRef.current!;
    const previewHost = previewRef.current!;

    const { provider, ytext, disconnect } = connect({ url: collabUrl, docName, token });
    awarenessRef.current = provider.awareness ?? null;
    provider.awareness?.setLocalStateField("user", userField(user));

    const sourceView = mountSource(sourceHost, ytext, provider, { readOnly });
    const previewView = mountLivePreview(previewHost, ytext, provider, { readOnly });

    return () => {
      // Tear down the CodeMirror views, then fully disconnect (drops presence +
      // closes the WebSocket + frees the doc — see collab.ts). Robust to
      // StrictMode (destroy -> immediate re-connect) because each mount owns its
      // own Y.Doc/provider/socket.
      sourceView.destroy();
      previewView.destroy();
      disconnect();
      awarenessRef.current = null;
      // mountLivePreview appends a toolbar + host wrapper imperatively; clear any
      // leftover imperative DOM so a re-mount can't duplicate it.
      sourceHost.replaceChildren();
      previewHost.replaceChildren();
    };
  }, [docName, token, collabUrl, readOnly]);

  // Presence label changes must NOT rebuild the editors — just update awareness.
  useEffect(() => {
    awarenessRef.current?.setLocalStateField("user", userField(user));
  }, [user.name, user.color]);

  return (
    <div className={styles.editor}>
      <section className={styles.pane}>
        <h2 className={styles.paneTitle}>source (vim)</h2>
        <div ref={sourceRef} className={styles.host} data-pane="source" />
      </section>
      <section className={styles.pane}>
        <h2 className={styles.paneTitle}>live preview</h2>
        <div ref={previewRef} className={styles.host} data-pane="preview" />
      </section>
    </div>
  );
}
