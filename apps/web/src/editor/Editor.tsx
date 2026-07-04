import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { headingsExtension, extractHeadings, type Heading } from "./headings";
import { connect, connectEphemeral } from "./collab";
import { mountLivePreview, mountPublishedView, vimCompartmentContent, displayModeContent } from "./editor-livepreview";
import type { DisplayMode, MacroTheme } from "./live-preview/decorations";
import { redrawMacros } from "./live-preview/decorations";
import { useTheme } from "../app/ThemeProvider";
import { makeMacroPresence } from "./macro-presence";
import { makeImageResolver } from "./image-resolver";
import { makeDiagramRenderer } from "./diagram-renderer";
import { makeTranscludeResolver } from "./transclude-resolver";
import { PageEmbedPicker } from "./PageEmbedPicker";
import { EmbedUrlModal } from "./EmbedUrlModal";
import type { PageEmbedPicker as PageEmbedPickerFn } from "./live-preview/palette";
import type { EmbedUrlPrompt as EmbedUrlPromptFn } from "./live-preview/decorations";
import { useEmbedProviders } from "../data/queries";
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
  // The page id (for host-mediated diagram render — POST /pages/:pageId/plantuml/render, #140).
  // Omit outside a page context; plantuml then just degrades to its source.
  pageId?: string;
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
  // ADR-056 / #164: editor display mode (live/source/…), orthogonal to vim. Default "live".
  displayMode?: DisplayMode;
  // Uploads a picked image and returns the ref+alt to insert. Omit to hide the
  // image button (e.g. guests, or a view-only surface).
  onUploadImage?: (file: File) => Promise<{ ref: string; alt: string } | null>;
  // Inline comments to highlight (resolved against the live doc → blue underline).
  inlineComments?: InlineThread[];
  // The host sets this ref to a getter that builds an anchor from the current
  // selection (for "Add comment on selection"). Null when nothing is selected.
  anchorGetterRef?: MutableRefObject<AnchorGetter | null>;
  // #192 / ADR-091: table of contents. onHeadings fires with the doc's headings (initial + each edit);
  // onActiveHeading reports the topmost visible heading on scroll (scroll-spy); tocJumpRef is set to a
  // "scroll to this heading offset" function the TOC rail calls. All display-only (read state / scroll).
  onHeadings?: (headings: Heading[]) => void;
  onActiveHeading?: (from: number | null) => void;
  onScrollActivity?: () => void; // #192: fires on each editor scroll (drives the narrow TOC overlay)
  tocJumpRef?: MutableRefObject<((from: number) => void) | null>;
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
// #192 / ADR-091: wire the TOC into a mounted CM view (edit OR published surface): headings extension
// (initial + on-edit), a jump function (scroll to a heading offset), and scroll-spy (report the topmost
// visible heading). All display-only. Returns a cleanup. Adds the headings listener via appendConfig so
// the mount functions don't need to know about the TOC.
function wireToc(
  view: EditorView,
  opts: { onHeadings?: (h: Heading[]) => void; onActiveHeading?: (from: number | null) => void; onScrollActivity?: () => void; tocJumpRef?: MutableRefObject<((from: number) => void) | null> },
): () => void {
  const cleanups: (() => void)[] = [];
  if (opts.onHeadings) view.dispatch({ effects: StateEffect.appendConfig.of(headingsExtension(opts.onHeadings)) });
  if (opts.tocJumpRef) {
    const ref = opts.tocJumpRef;
    ref.current = (from: number) => {
      const pos = Math.min(from, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start" }) });
      if (!view.state.readOnly) view.focus();
    };
    cleanups.push(() => { ref.current = null; });
  }
  if (opts.onActiveHeading || opts.onScrollActivity) {
    const report = opts.onActiveHeading;
    const activity = opts.onScrollActivity;
    let raf = 0;
    const compute = () => {
      raf = 0;
      if (!report) return;
      // #192 (bounce): find the heading whose section contains the TOP of the viewport. Resolve the DOC
      // POSITION at the top band once (posAtCoords) and compare heading doc offsets — this is robust for
      // headings scrolled ABOVE the viewport, whose per-position coordsAtPos returns null. The previous
      // impl called coordsAtPos on EACH heading AND defaulted `active` to the FIRST heading: once you
      // scrolled a long section past the top, that section's heading (now off-screen) returned null, no
      // heading updated `active`, and it stayed on the FIRST heading (the reported "highlights the TOC
      // top heading while I'm deep in a section" bug).
      const rect = view.scrollDOM.getBoundingClientRect();
      const hs = extractHeadings(view.state);
      const topPos = view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + 48 });
      let active: number | null = null;
      if (topPos != null) {
        for (const h of hs) {
          if (h.from <= topPos) active = h.from; // last heading at/above the viewport top → current section
          else break; // headings are in doc order
        }
      }
      report(active);
    };
    const onScroll = () => {
      activity?.(); // #192: drive the narrow-screen TOC overlay's "visible while scrolling"
      if (report && !raf) raf = requestAnimationFrame(compute);
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    cleanups.push(() => { view.scrollDOM.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); });
    if (report) raf = requestAnimationFrame(compute); // initial active
  }
  return () => cleanups.forEach((c) => c());
}

export const Editor = memo(function Editor({ docName, pageId, token, collabUrl, user, capability = "view", apiToken = "", publishedMd = null, editing = false, vim = false, displayMode = "live", onUploadImage, inlineComments, anchorGetterRef, onHeadings, onActiveHeading, onScrollActivity, tocJumpRef, dirtySignal, onExitEdit, onPublish, onToggleTask }: EditorProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme(); // #200: re-render macro widgets (Excalidraw etc.) on a light/dark switch
  const collabRef = useRef<ReturnType<typeof connect> | null>(null);
  const previewViewRef = useRef<EditorView | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  // Owned here so the vim toggle reconfigures the SAME compartment in place.
  const vimCompartment = useRef(new Compartment()).current;
  // ADR-056 / #164: display-mode Compartment, reconfigured in place on a mode switch (no remount).
  const displayModeCompartment = useRef(new Compartment()).current;

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
  // #140: host-mediated diagram render (plantuml). Only when we have a pageId (the render endpoint is
  // page-scoped + page-view gated); otherwise undefined → the macro degrades to its source fence.
  const renderDiagram = useMemo(() => (pageId ? makeDiagramRenderer(apiToken, pageId) : undefined), [apiToken, pageId]);
  // #108: host-mediated internal transclude (the :::transclude macro never fetches). page-scoped (the
  // server re-checks view on the referenced page); undefined without a pageId → placeholder.
  const resolveTransclude = useMemo(() => (pageId ? makeTranscludeResolver(apiToken, pageId) : undefined), [apiToken, pageId]);
  // #108 / ADR-071 (comment 551): the tenant external-embed host allowlist for the client-direct
  // sandboxed iframe. Stable reference (react-query) so it doesn't churn the surface remount.
  const embedQuery = useEmbedProviders();
  const embedProviders = useMemo(() => embedQuery.data?.providers ?? [], [embedQuery.data]);
  // #205 part 2: the `:::embed-page` title-search picker. The slash command calls openPageEmbedPicker
  // (stable, so it doesn't churn the surface remount); we stash the CM callback, open the modal, and
  // resolve it with the chosen page id (or null on cancel). Candidates are FGA-view-filtered by
  // /search (in PageEmbedPicker) — no existence leak.
  const [embedPickerOpen, setEmbedPickerOpen] = useState(false);
  const embedPickResolve = useRef<((id: string | null) => void) | null>(null);
  const openPageEmbedPicker = useCallback<PageEmbedPickerFn>((onPick) => {
    embedPickResolve.current = onPick;
    setEmbedPickerOpen(true);
  }, []);
  const handleEmbedPick = useCallback((id: string | null) => {
    setEmbedPickerOpen(false);
    const r = embedPickResolve.current;
    embedPickResolve.current = null;
    r?.(id);
  }, []);
  // #210 bounce: the in-app `:::embed-external` URL modal (replaces window.prompt). Same stash/open/
  // resolve pattern as the page picker; the modal is seeded with the current URL and warns on a
  // non-allowlisted host (the render still degrades — this is UI only).
  const [embedUrlState, setEmbedUrlState] = useState<{ open: boolean; current: string }>({ open: false, current: "" });
  const embedUrlResolve = useRef<((url: string | null) => void) | null>(null);
  const openEmbedUrlPrompt = useCallback<EmbedUrlPromptFn>((current, onSubmit) => {
    embedUrlResolve.current = onSubmit;
    setEmbedUrlState({ open: true, current });
  }, []);
  const handleEmbedUrl = useCallback((url: string | null) => {
    setEmbedUrlState((s) => ({ ...s, open: false }));
    const r = embedUrlResolve.current;
    embedUrlResolve.current = null;
    r?.(url);
  }, []);

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
      const v = mountPublishedView(previewHost, publishedMd ?? "", { resolveImageUrl, renderDiagram, resolveTransclude, embedProviders, onToggleTask: onToggleTaskInView });
      views.push(v);
      previewViewRef.current = v;
      if (anchorGetterRef) anchorGetterRef.current = null;
      const tocCleanup = wireToc(v, { onHeadings, onActiveHeading, onScrollActivity, tocJumpRef }); // #192 TOC (reading/view surface)
      return () => {
        tocCleanup();
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
      renderDiagram,
      resolveTransclude,
      embedProviders,
      openPageEmbedPicker,
      openEmbedUrlPrompt,
      uploadImage: onUploadImage,
      vim,
      vimCompartment,
      displayMode,
      displayModeCompartment,
      onExitEdit,
      onPublish,
      // #92 / ADR-093: the host ephemeral-collab seam — opens a non-persisted room for a co-editing
      // macro modal (excalidraw). Keyed by docName + the macro's anchor; token/url from the same collab.
      // The local user (name/color) is published on the ephemeral awareness so the macro can render
      // remote collaborator cursors on the canvas with the SAME identity as the page's yCollab carets
      // (#92 canvas cursors). The macro host-API stays {theme}; identity rides this host-injected seam.
      ephemeralCollab: (anchor: string) => {
        const session = connectEphemeral({ url: collabUrl, docName, anchor, token });
        try { session.awareness?.setLocalStateField("user", userField(user)); } catch { /* awareness gone */ }
        return session;
      },
      // #92 presence: publish "editing this macro" onto the page awareness so co-editors see a badge
      // at the macro's anchor while its modal is open (they'd otherwise see this user vanish).
      macroPresence: c.provider.awareness ? makeMacroPresence(c.provider.awareness) : undefined,
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
    const tocCleanup = wireToc(previewView, { onHeadings, onActiveHeading, onScrollActivity, tocJumpRef }); // #192 TOC (edit surface)

    return () => {
      tocCleanup();
      views.forEach((v) => v.destroy());
      previewViewRef.current = null;
      if (anchorGetterRef) anchorGetterRef.current = null;
      previewHost.replaceChildren();
    };
    // vim excluded (Compartment reconfigure, not a remount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docName, token, collabUrl, surfaceKey, resolveImageUrl, renderDiagram, resolveTransclude, embedProviders, openPageEmbedPicker, openEmbedUrlPrompt, onUploadImage]);

  // vim on/off: reconfigure the Compartment IN PLACE (no remount → collab/presence
  // untouched). Only meaningful on the edit surface.
  useEffect(() => {
    const v = previewViewRef.current;
    if (!v || surfaceKey !== "edit") return;
    v.dispatch({ effects: vimCompartment.reconfigure(vimCompartmentContent(vim)) });
  }, [vim, surfaceKey, vimCompartment]);

  // Display mode switch (ADR-056 / #164): reconfigure the Compartment in place (no remount →
  // collab/presence untouched), exactly like vim. Edit surface only.
  useEffect(() => {
    const v = previewViewRef.current;
    if (!v || surfaceKey !== "edit") return;
    v.dispatch({ effects: displayModeCompartment.reconfigure(displayModeContent(displayMode)) });
  }, [displayMode, surfaceKey, displayModeCompartment]);

  // #200: on a light/dark theme change, tell the live-preview to rebuild macro widgets so a macro that
  // bakes theme colours into its output (Excalidraw's exported SVG) re-renders for the new theme. We
  // pass the RESOLVED theme in the effect payload — NOT relying on <html data-theme>, which is still
  // stale here: this effect (a ThemeProvider child) fires BEFORE ThemeProvider's own effect updates
  // the DOM (React runs effects child→parent). CSS-driven macros (callouts) re-theme for free.
  useEffect(() => {
    const resolved: MacroTheme = theme === "system"
      ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme;
    previewViewRef.current?.dispatch({ effects: redrawMacros.of(resolved) });
  }, [theme]);

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
      {/* #205 part 2: the :::embed-page title-search picker (opened from the slash command). */}
      <PageEmbedPicker open={embedPickerOpen} onPick={handleEmbedPick} />
      <EmbedUrlModal open={embedUrlState.open} current={embedUrlState.current} onSubmit={handleEmbedUrl} />
    </div>
  );
});
