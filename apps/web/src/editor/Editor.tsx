import { memo, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import { Compartment } from "@codemirror/state";
import { vim as vimKeymap } from "@replit/codemirror-vim";
import type { EditorView } from "@codemirror/view";
import { connect } from "./collab";
import { mountLivePreview, mountPublishedView } from "./editor-livepreview";
import { makeImageResolver } from "./image-resolver";
import { createAnchor, resolveAnchor } from "./comment-anchors";
import { setCommentRanges, type CommentRange } from "./live-preview/comment-highlights";
import type { DirtySignal } from "./dirtySignal";

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
  // Peer-visible avatar URL (OIDC `picture`); null → initials avatar. Carried in the
  // awareness payload so remote collaborators can render it on the cursor (#8).
  picture?: string | null;
  // Stable colour/identity seed (the member's sub) — kept off the wire-visible name so
  // avatars don't recolour on rename. Optional: guests/anon have none.
  seed?: string;
}

export type EditorCapability = "view" | "edit";

// Single-view editing model (Step I). Two states, both host-controlled:
//   - editing: the page opens RENDERED (published, read-only) for everyone; an
//     edit-capable user enters edit via the host's Edit control → ONE live-preview
//     surface (no split, no separate source pane).
//   - vim: an optional keymap on that surface (cursor line/block reveals raw markdown,
//     reveal-on-cursor). Toggled via a Compartment in place — never remounts, so
//     collab/presence are never dropped.
// The mounted surface: 'view' (read-only published) | 'edit' (live collab draft).
type SurfaceKey = "view" | "edit";

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
  // shown (only honored for edit-capable users), and whether vim keymap is on.
  editing?: boolean;
  vim?: boolean;
  // Uploads a picked image and returns the ref+alt to insert. Omit to hide the
  // image button (e.g. guests, or a view-only surface).
  onUploadImage?: (file: File) => Promise<{ ref: string; alt: string } | null>;
  // Inline comments to highlight (resolved against the live doc → blue underline).
  inlineComments?: InlineThread[];
  // The host sets this ref to a getter that builds an anchor from the current
  // selection (for "Add comment on selection"). Null when nothing is selected.
  anchorGetterRef?: MutableRefObject<AnchorGetter | null>;
  // External "unpublished changes" store written here (edit mode) and read only by
  // the publish control — NOT React state, so writing it never re-renders the editor
  // or its host (keeps it off the presence path). The canonical Y.Text IS the
  // markdown, so `ytext !== publishedMd` is exactly the server's check, but instant.
  dirtySignal?: DirtySignal;
  // vim ex-command entry points (Light-3): :q → onExitEdit, :w/:wq → onPublish. Pass
  // STABLE callbacks (useCallback) — captured at mount, not in the surface-effect deps.
  onExitEdit?: () => void;
  onPublish?: () => void;
  // Persist a view-mode task-checkbox toggle (ADR-019): the host POSTs the no-revision
  // endpoint for task `index` and refetches the published snapshot. Provided only for an
  // edit-capable viewer; absent → checkboxes render disabled. Editor flips the live draft
  // over its collab connection, then calls this; a rejection (409 dirty/mixed, 403)
  // reverts the optimistic draft flip. Pass a STABLE callback (captured at mount).
  onToggleTask?: (index: number) => Promise<void>;
}

function userField(user: EditorUser) {
  // colorLight (caret-selection tint) uses an HSL alpha so it works whether `color`
  // is hex (#rrggbb) or hsl(...) — the deterministic palette is HSL.
  return { name: user.name, color: user.color, colorLight: tint(user.color), picture: user.picture ?? null };
}

// Translucent variant of the caret colour for the selection highlight. hsl(...) →
// hsl(... / 0.2); hex → append a 33 (20%) alpha. Keeps both colour spaces working.
function tint(color: string): string {
  return color.startsWith("hsl(") ? color.replace(/\)\s*$/, " / 0.2)") : `${color}33`;
}

// React wrapper around the CodeMirror surface. TWO independent lifecycles (ADR-013):
//   1. COLLAB connection — keyed on (docName, token, collabUrl). Owns the provider /
//      Y.Doc / WebSocket / awareness. Mode + vim toggles do NOT touch it, so
//      view↔edit and vim on/off never reconnect, never drop presence, never leave a
//      ghost cursor. Only a page (docName) switch rebuilds it.
//   2. SURFACE view — keyed additionally on the surface. Mounts/destroys the CM view
//      onto the SAME canonical Y.Text. vim is a Compartment reconfigure (no remount).
//
// memo: the host (PageRoute) re-renders on its own state and on the published poll;
// without memo those re-render <Editor> too, which the tree-move e2e forbids and
// churns the editor. Props are referentially stable across host re-renders.
export const Editor = memo(function Editor({ docName, token, collabUrl, user, capability = "view", apiToken = "", publishedMd = null, editing = false, vim = false, onUploadImage, inlineComments, anchorGetterRef, dirtySignal, onExitEdit, onPublish, onToggleTask }: EditorProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const collabRef = useRef<ReturnType<typeof connect> | null>(null);
  const previewViewRef = useRef<EditorView | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  // Owned here so the vim toggle reconfigures the SAME compartment in place.
  const vimCompartment = useRef(new Compartment()).current;

  // Resolve inline-comment anchors against the live doc and push the ranges to the
  // preview's highlight field.
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
  // editing is controlled by the host (PageToolbar). A view-only capability can never
  // edit (surface stays "view") — the collab server is the fortress regardless.
  const surfaceKey: SurfaceKey = canEdit && editing ? "edit" : "view";

  const resolveImageUrl = useMemo(() => makeImageResolver(apiToken), [apiToken]);

  // Dev-only probe for the isolation invariant (ADR-013): editor content is not in
  // React state, so typing must NOT re-render this component (read before/after).
  if (import.meta.env.DEV) {
    (window as unknown as { __editorRenders?: number }).__editorRenders =
      ((window as unknown as { __editorRenders?: number }).__editorRenders ?? 0) + 1;
  }

  // (1) Collab connection — ONLY for edit-capable users (security, not just UI): a
  // view-only user / view share-link never joins the collab room. Survives view↔edit
  // and vim toggles (keyed on docName/token), so toggling never drops presence.
  useLayoutEffect(() => {
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

  // (2) Surface — remount when the surface changes (same connection) or after a
  // reconnect. vim is NOT in the deps (a Compartment reconfigure, below).
  useLayoutEffect(() => {
    const previewHost = previewRef.current!;
    const views: { destroy(): void }[] = [];

    // VIEW mode: render the PUBLISHED snapshot read-only — NOT collab-bound.
    if (surfaceKey === "view") {
      // Edit-capable viewers get interactive task checkboxes (ADR-019). A click flips
      // the LIVE draft over the existing collab connection (canEdit ⇒ effect 1 has
      // opened it), then persists via the no-revision endpoint; a rejection (409
      // dirty/mixed, 403) reverts our single flip so the draft is left untouched.
      const onToggleTaskInView = canEdit && onToggleTask
        ? (index: number, from: number, checked: boolean) => {
            const c = collabRef.current;
            if (!c) return;
            const set = (ch: string) => { c.ytext.delete(from + 1, 1); c.ytext.insert(from + 1, ch); };
            set(checked ? " " : "x"); // optimistic draft flip
            onToggleTask(index).catch(() => set(checked ? "x" : " ")); // revert on failure
          }
        : undefined;
      const v = mountPublishedView(previewHost, publishedMd ?? "", { resolveImageUrl, onToggleTask: onToggleTaskInView });
      views.push(v);
      previewViewRef.current = v;
      if (anchorGetterRef) anchorGetterRef.current = null;
      return () => {
        views.forEach((x) => x.destroy());
        previewViewRef.current = null;
        previewHost.replaceChildren();
      };
    }

    // EDIT: the single live-preview surface on the live collab doc.
    const c = collabRef.current;
    if (!c) return;
    const previewView = mountLivePreview(previewHost, c.ytext, c.provider, {
      readOnly: false,
      resolveImageUrl,
      uploadImage: onUploadImage,
      vim,
      vimCompartment,
      onExitEdit,
      onPublish,
    });
    views.push(previewView);
    previewViewRef.current = previewView;

    if (anchorGetterRef) {
      anchorGetterRef.current = () => {
        const sel = previewView.state.selection.main;
        if (sel.empty) return null;
        const { start, end } = createAnchor(c.ytext, sel.from, sel.to);
        return { anchorStart: start, anchorEnd: end, quotedText: previewView.state.doc.sliceString(sel.from, sel.to) };
      };
    }
    pushHighlights(previewView);

    return () => {
      views.forEach((v) => v.destroy());
      previewViewRef.current = null;
      if (anchorGetterRef) anchorGetterRef.current = null;
      previewHost.replaceChildren();
    };
    // vim excluded (Compartment reconfigure, not a remount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docName, token, collabUrl, surfaceKey, resolveImageUrl, onUploadImage]);

  // vim on/off: reconfigure the Compartment IN PLACE (no remount → collab/presence
  // untouched). Only meaningful on the edit surface.
  useEffect(() => {
    const v = previewViewRef.current;
    if (!v || surfaceKey !== "edit") return;
    v.dispatch({ effects: vimCompartment.reconfigure(vim ? vimKeymap() : []) });
  }, [vim, surfaceKey, vimCompartment]);

  // Keep the published view in sync when publishedMd changes WITHOUT remounting.
  useEffect(() => {
    if (surfaceKey !== "view") return;
    const v = previewViewRef.current;
    if (!v) return;
    const next = publishedMd ?? "";
    if (v.state.doc.toString() !== next) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } });
    }
  }, [publishedMd, surfaceKey]);

  useEffect(() => { pushHighlights(previewViewRef.current); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineComments]);

  // Optimistic "unpublished changes" signal: a passive DOM `input` listener on the
  // edit surface flips the external store to true the instant the user edits. NOT a
  // Yjs/CM observer (that destabilized presence e2e — see editor-dirty-presence-
  // constraint); a DOM input listener is orthogonal to the collab/awareness path.
  useEffect(() => {
    if (!dirtySignal || !(canEdit && editing)) return;
    const host = previewRef.current;
    const onInput = () => dirtySignal.set(true);
    host?.addEventListener("input", onInput);
    return () => host?.removeEventListener("input", onInput);
  }, [canEdit, editing, surfaceKey, dirtySignal]);

  // Presence label changes must NOT rebuild the editor — just update awareness.
  useEffect(() => {
    awarenessRef.current?.setLocalStateField("user", userField(user));
  }, [user.name, user.color, user.picture]);

  return (
    <div className="h-full" data-mode={surfaceKey}>
      <section className="flex h-full min-h-0 min-w-0 flex-col" data-pane="preview">
        {/* Edit/Done/vim controls live in the host PageToolbar. */}
        <div ref={previewRef} className="flex min-h-0 flex-1 flex-col" />
      </section>
    </div>
  );
});
