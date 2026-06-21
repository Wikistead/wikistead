import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { connect } from "./collab";
import { mountSource } from "./editor-source";
import { mountLivePreview } from "./editor-livepreview";
import { makeImageResolver } from "./image-resolver";
import { createAnchor, resolveAnchor } from "./comment-anchors";
import { setCommentRanges, type CommentRange } from "./live-preview/comment-highlights";
import styles from "./Editor.module.css";

// Inline-comment integration surface for the host (CommentsPanel via PageRoute).
export interface InlineAnchorInput { anchorStart: string; anchorEnd: string; quotedText: string }
export interface InlineThread { threadId: string; anchorStart: string; anchorEnd: string; resolved: boolean }
export type AnchorGetter = () => InlineAnchorInput | null;

// Awareness type derived from the provider so we don't take a direct dependency
// on y-protocols just for a type.
type Awareness = NonNullable<ReturnType<typeof connect>["provider"]["awareness"]>;

export interface EditorUser {
  name: string;
  color: string;
}

export type EditorCapability = "view" | "edit";

// Two orthogonal concerns:
//   - editing (transient, default false): the page opens RENDERED (read-only
//     preview) for everyone; an edit-capable user clicks Edit to start editing.
//   - layout (PERSISTED per user): when editing, which editor — a single WYSIWYG
//     preview, or the vim source + preview split. A split user always edits in
//     split; everyone else always gets the single editor. Persisted so the choice
//     sticks across pages and sessions.
export type EditorLayout = "wysiwyg" | "split";
// The mounted surface: 'view' (read-only preview) | 'wysiwyg' (editable preview) |
// 'split' (source + editable preview).
type SurfaceKey = "view" | EditorLayout;

const LAYOUT_KEY = "wks.editorLayout";
function loadLayout(): EditorLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "wysiwyg";
  } catch {
    return "wysiwyg";
  }
}
function saveLayout(l: EditorLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, l);
  } catch {
    /* private mode / no storage — preference just won't persist */
  }
}

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
  // Uploads a picked image and returns the ref+alt to insert. Omit to hide the
  // image button (e.g. guests, or a view-only surface).
  onUploadImage?: (file: File) => Promise<{ ref: string; alt: string } | null>;
  // Inline comments to highlight (resolved against the live doc → blue underline).
  inlineComments?: InlineThread[];
  // The host sets this ref to a getter that builds an anchor from the current
  // selection (for "Add comment on selection"). Null when nothing is selected.
  anchorGetterRef?: MutableRefObject<AnchorGetter | null>;
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
export function Editor({ docName, token, collabUrl, user, capability = "view", apiToken = "", onUploadImage, inlineComments, anchorGetterRef }: EditorProps) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const collabRef = useRef<ReturnType<typeof connect> | null>(null);
  const previewViewRef = useRef<EditorView | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);

  // Resolve inline-comment anchors against the live doc and push the ranges to the
  // preview's highlight field. The field maps marks through edits between pushes, so
  // highlights track text live; we re-resolve when the comment set changes.
  const pushHighlights = (view: EditorView | null) => {
    const c = collabRef.current;
    if (!view || !c) return;
    const ranges: CommentRange[] = (inlineComments ?? [])
      .map((t) => {
        const r = resolveAnchor(c.doc, { start: t.anchorStart, end: t.anchorEnd });
        return r ? { from: r.from, to: r.to, resolved: t.resolved } : null;
      })
      .filter((r): r is CommentRange => r !== null);
    view.dispatch({ effects: setCommentRanges.of(ranges) });
  };

  const canEdit = capability === "edit";
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<EditorLayout>(loadLayout);
  const setLayoutPref = (l: EditorLayout) => { setLayout(l); saveLayout(l); };
  // A view-only capability can never edit (the controls aren't rendered, and this
  // guarantees it even if some state went stale). The collab server is the fortress.
  const surfaceKey: SurfaceKey = canEdit && editing ? layout : "view";

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

  // (2) Surfaces — remount when the surface changes (same connection) or after a
  // reconnect. The collab connection above is untouched, so editing/layout toggles
  // never reconnect or drop presence.
  useLayoutEffect(() => {
    const c = collabRef.current;
    if (!c) return;
    const editable = surfaceKey !== "view";
    const sourceHost = sourceRef.current;
    const previewHost = previewRef.current!;

    const views: { destroy(): void }[] = [];
    if (surfaceKey === "split" && sourceHost) {
      views.push(mountSource(sourceHost, c.ytext, c.provider, { readOnly: false }));
    }
    const previewView = mountLivePreview(previewHost, c.ytext, c.provider, { readOnly: !editable, resolveImageUrl, uploadImage: onUploadImage });
    views.push(previewView);
    previewViewRef.current = previewView;

    // Expose an anchor getter built from the preview's current selection (works in
    // any mode — read-only CM still has a selection). Null when nothing is selected.
    if (anchorGetterRef) {
      anchorGetterRef.current = () => {
        const sel = previewView.state.selection.main;
        if (sel.empty) return null;
        const { start, end } = createAnchor(c.ytext, sel.from, sel.to);
        return { anchorStart: start, anchorEnd: end, quotedText: previewView.state.doc.sliceString(sel.from, sel.to) };
      };
    }
    pushHighlights(previewView); // initial highlights for this freshly-mounted view

    return () => {
      views.forEach((v) => v.destroy());
      previewViewRef.current = null;
      if (anchorGetterRef) anchorGetterRef.current = null;
      sourceHost?.replaceChildren();
      previewHost.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docName, token, collabUrl, surfaceKey, resolveImageUrl, onUploadImage]);

  // Re-resolve + push highlights when the comment set changes (the StateField keeps
  // them aligned through edits in between).
  useEffect(() => { pushHighlights(previewViewRef.current); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineComments]);

  // Presence label changes must NOT rebuild the editors — just update awareness.
  useEffect(() => {
    awarenessRef.current?.setLocalStateField("user", userField(user));
  }, [user.name, user.color]);

  return (
    <div className={styles.editor} data-mode={surfaceKey}>
      <section className={styles.pane} data-pane="source" hidden={surfaceKey !== "split"}>
        <h2 className={styles.paneTitle}>source (vim)</h2>
        <div ref={sourceRef} className={styles.host} />
      </section>
      <section className={styles.pane} data-pane="preview">
        {canEdit && (
          <div className={styles.modeBar} data-testid="editor-modebar">
            {surfaceKey === "view" ? (
              <button type="button" data-testid="edit-toggle" onClick={() => setEditing(true)}>Edit</button>
            ) : (
              <>
                {/* Persisted layout preference: split users stay in split, others in single. */}
                <button
                  type="button"
                  data-testid="layout-toggle"
                  aria-pressed={layout === "split"}
                  onClick={() => setLayoutPref(layout === "split" ? "wysiwyg" : "split")}
                >
                  {layout === "split" ? "Single editor" : "Split editor (vim)"}
                </button>
                <button type="button" data-testid="view-toggle" onClick={() => setEditing(false)}>Done</button>
              </>
            )}
          </div>
        )}
        <div ref={previewRef} className={styles.host} />
      </section>
    </div>
  );
}
