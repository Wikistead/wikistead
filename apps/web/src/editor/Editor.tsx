import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { connect } from "./collab";
import { mountSource } from "./editor-source";
import { mountLivePreview, mountPublishedView } from "./editor-livepreview";
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

// Two orthogonal concerns, both now CONTROLLED by the host (PageToolbar owns the
// chrome since 3b-3):
//   - editing: the page opens RENDERED (published, read-only) for everyone; an
//     edit-capable user enters edit via the host's Edit control.
//   - layout: when editing, which editor — single WYSIWYG preview, or vim source +
//     preview split. The host persists the preference.
export type EditorLayout = "wysiwyg" | "split";
// The mounted surface: 'view' (read-only preview) | 'wysiwyg' (editable preview) |
// 'split' (source + editable preview).
type SurfaceKey = "view" | EditorLayout;

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
  // The PUBLISHED markdown rendered in view mode (draft/publish model). The live
  // draft (collab) is only ever shown in EDIT mode; view shows this snapshot.
  publishedMd?: string | null;
  // Controlled by the host (PageToolbar): whether the editable draft surface is
  // shown (only honored for edit-capable users) and which editor layout.
  editing?: boolean;
  layout?: EditorLayout;
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
export function Editor({ docName, token, collabUrl, user, capability = "view", apiToken = "", publishedMd = null, editing = false, layout = "wysiwyg", onUploadImage, inlineComments, anchorGetterRef }: EditorProps) {
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
  // editing + layout are controlled by the host (PageToolbar). A view-only
  // capability can never edit (surface stays "view" even if editing is forced) —
  // the collab server is the fortress regardless.
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

  // (1) Collab connection — ONLY for edit-capable users (security, not just UI):
  // a view-only user / view share-link never joins the collab room, so the live
  // draft is never delivered to their browser. They render the published snapshot
  // instead (mountPublishedView). For an edit-capable user the connection survives
  // view↔edit toggles (keyed on docName/token, not the surface), so toggling never
  // reconnects or drops presence (ADR-013).
  useLayoutEffect(() => {
    // Only edit-capable principals (members or edit share-link guests) join the
    // collab room. View-only users never receive the live draft — they render the
    // published snapshot over HTTP. Edit-capable users keep the connection across
    // view↔edit toggles (ADR-013), so toggling never reconnects or drops presence.
    if (!canEdit) return;
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
  }, [docName, token, collabUrl, canEdit]);

  // (2) Surfaces — remount when the surface changes (same connection) or after a
  // reconnect. The collab connection above is untouched, so editing/layout toggles
  // never reconnect or drop presence.
  useLayoutEffect(() => {
    const sourceHost = sourceRef.current;
    const previewHost = previewRef.current!;
    const views: { destroy(): void }[] = [];

    // VIEW mode: render the PUBLISHED snapshot read-only — NOT collab-bound, so the
    // live draft is never shown here (and a view-only user has no collab at all).
    if (surfaceKey === "view") {
      const v = mountPublishedView(previewHost, publishedMd ?? "", { resolveImageUrl });
      views.push(v);
      previewViewRef.current = v;
      if (anchorGetterRef) anchorGetterRef.current = null; // no selection-anchoring in view
      return () => {
        views.forEach((x) => x.destroy());
        previewViewRef.current = null;
        sourceHost?.replaceChildren();
        previewHost.replaceChildren();
      };
    }

    // EDIT surfaces use the live collab doc.
    const c = collabRef.current;
    if (!c) return;
    const editable = true;
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

  // Keep the published view in sync when publishedMd changes (e.g. after a publish,
  // or a remote publish) WITHOUT remounting — a plain doc replace on the read-only
  // view. Edit mode is untouched (publishedMd is not in the surface effect's deps,
  // so a publish never rebuilds the live editor / drops the caret).
  useEffect(() => {
    if (surfaceKey !== "view") return; // only the published view (not a collab CM)
    const v = previewViewRef.current;
    if (!v) return;
    const next = publishedMd ?? "";
    if (v.state.doc.toString() !== next) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } });
    }
  }, [publishedMd, surfaceKey]);

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
        {/* Edit/Done/layout controls live in the host PageToolbar (3b-3). */}
        <div ref={previewRef} className={styles.host} />
      </section>
    </div>
  );
}
