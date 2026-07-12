import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { headingsExtension, extractHeadings, type Heading } from "./headings";
import { taskProgressExtension, type TaskProgress } from "./task-progress"; // #290: page task-progress ring
import { connect, connectEphemeral } from "./collab";
import { mountLivePreview, mountPublishedView, vimCompartmentContent, displayModeContent } from "./editor-livepreview";
import type { DisplayMode, MacroTheme, BacklinksSource } from "./live-preview/decorations";
import { redrawMacros, taskStatePosAt } from "./live-preview/decorations";
import i18n from "../i18n"; // #307: strings for the host-owned :::backlinks source (i18n stays out of the CM layer)
import { useTheme } from "../app/ThemeProvider";
import { makeMacroPresence } from "./macro-presence";
import { makeImageResolver } from "./image-resolver";
import { makeAttachmentResolver } from "./attachment-resolver";
import { makeDiagramRenderer } from "./diagram-renderer";
import { makeTranscludeResolver } from "./transclude-resolver";
import { PageEmbedPicker } from "./PageEmbedPicker";
import { EmbedUrlModal } from "./EmbedUrlModal";
import { TemplatePickerDialog } from "../sidebar/TemplatePickerDialog";
import type { PageEmbedPicker as PageEmbedPickerFn, TemplateInsertPicker as TemplateInsertPickerFn } from "./live-preview/palette";
import type { EmbedUrlPrompt as EmbedUrlPromptFn } from "./live-preview/decorations";
import { useEmbedProviders, useTitleDictionary } from "../data/queries";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { titleLinksRefresh, type TitleLinkSource } from "./live-preview/title-links-deco";
import type { TitleEntry } from "./live-preview/title-links";
import { apiFetch } from "../data/apiClient";
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
  onTaskProgress?: (p: TaskProgress) => void; // #290: the page's GFM-checkbox progress (title-band ring)
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
  opts: { onHeadings?: (h: Heading[]) => void; onActiveHeading?: (from: number | null) => void; onScrollActivity?: () => void; tocJumpRef?: MutableRefObject<((from: number) => void) | null>; onTaskProgress?: (p: TaskProgress) => void },
): () => void {
  const cleanups: (() => void)[] = [];
  if (opts.onHeadings) view.dispatch({ effects: StateEffect.appendConfig.of(headingsExtension(opts.onHeadings)) });
  if (opts.onTaskProgress) view.dispatch({ effects: StateEffect.appendConfig.of(taskProgressExtension(opts.onTaskProgress)) }); // #290
  if (opts.tocJumpRef) {
    const ref = opts.tocJumpRef;
    ref.current = (from: number) => {
      const pos = Math.min(from, view.state.doc.length);
      // #345: tag the jump as `select.jump` so the #306 scrolloff listener SKIPS it. A TOC/anchor jump's
      // contract is "land the heading flush under the band" (bandScrollMargins handles that); the scrolloff's
      // "keep the caret in the 25% band" correction fights it and dragged the landing ~55px too low, so the
      // scroll-spy then highlighted the PREVIOUS heading (the #304 off-by-one regression, toc-304 red).
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start" }), userEvent: "select.jump" });
      if (!view.state.readOnly) view.focus();
      // #304 (3): report the jumped-to heading as active IMMEDIATELY — don't wait for the scroll event's
      // recompute (which would otherwise, for a frame, keep the previous section highlighted). The scroll
      // recompute converges to the same result via the band-aware sample below.
      opts.onActiveHeading?.(from);
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
      // #304 (1): sample at the frosted title band's REAL height, not a fixed 48px. A 2-line title makes the
      // band taller than 48px, and tocJump lands a heading just BELOW the band; a fixed-48 sample point then
      // sits ABOVE the landed heading, so the PREVIOUS heading matched (h.from <= topPos) — the clicked item
      // never lit. The band height is the content's padding-top (--wks-band-h); 0 on bandless routes.
      const bandH = parseFloat(getComputedStyle(view.contentDOM).paddingTop) || 0;
      const topPos = view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + bandH + 8 });
      let active: number | null = null;
      if (topPos != null) {
        for (const h of hs) {
          if (h.from <= topPos) active = h.from; // last heading at/above the viewport top → current section
          else break; // headings are in doc order
        }
      }
      // #304 (2): at the very bottom, a final section shorter than the viewport can never reach the sample
      // line, so its heading would never activate. Clamp: when scrolled to the end, the LAST heading is active.
      const sc = view.scrollDOM;
      if (hs.length && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) active = hs[hs.length - 1].from;
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

export const Editor = memo(function Editor({ docName, pageId, token, collabUrl, user, capability = "view", apiToken = "", publishedMd = null, editing = false, vim = false, displayMode = "live", onUploadImage, inlineComments, anchorGetterRef, onHeadings, onActiveHeading, onScrollActivity, tocJumpRef, onTaskProgress, dirtySignal, onExitEdit, onPublish, onToggleTask }: EditorProps) {
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
  // #273: file-attachment links (chip / download card / sandboxed PDF viewer) — same auth token.
  const resolveAttachment = useMemo(() => makeAttachmentResolver(apiToken), [apiToken]);
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
  const embedPickResolve = useRef<((id: string | null, title?: string | null) => void) | null>(null);
  const openPageEmbedPicker = useCallback<PageEmbedPickerFn>((onPick) => {
    embedPickResolve.current = onPick;
    setEmbedPickerOpen(true);
  }, []);
  const handleEmbedPick = useCallback((id: string | null, title?: string | null) => {
    setEmbedPickerOpen(false);
    const r = embedPickResolve.current;
    embedPickResolve.current = null;
    r?.(id, title ?? null); // #323: the title rides along for the page-link insert (embeds ignore it)
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
  // #251 / ADR-110: the "/"-palette "Insert template" picker. Same stash/open/resolve pattern as the embed
  // picker; on selection we fetch the chosen template's body (view-gated by the server) and resolve the CM
  // callback with it (the palette inserts it at the caret). Cancel resolves null (doc untouched).
  const [tplInsertOpen, setTplInsertOpen] = useState(false);
  const tplInsertResolve = useRef<((body: string | null) => void) | null>(null);
  const openTemplateInsertPicker = useCallback<TemplateInsertPickerFn>((onInsert) => {
    tplInsertResolve.current = onInsert;
    setTplInsertOpen(true);
  }, []);
  const handleTemplateInsertPick = useCallback(async (templateId: string | null) => {
    setTplInsertOpen(false);
    const resolve = tplInsertResolve.current;
    tplInsertResolve.current = null;
    if (!resolve) return;
    if (!templateId) { resolve(null); return; }
    try {
      const tpl = await apiFetch<{ body: string }>(`/templates/${encodeURIComponent(templateId)}`, apiToken);
      resolve(tpl?.body ?? null);
    } catch { resolve(null); }
  }, [apiToken]);

  // #224 / ADR-104 go-live: the viewer-scoped title dictionary. MEMBER surfaces only (gated on the
  // pageId prop — guest surfaces don't pass one, so they stay inert; the guest endpoint exists and is
  // public-only-bound server-side for a later guest go-live). The dictionary is read through a REF so
  // an invalidation refetch updates links in place (titleLinksRefresh) without remounting the editor.
  const navigateRouter = useNavigate();
  const queryClient = useQueryClient();
  const titleDictQ = useTitleDictionary(pageId);
  const titleDictRef = useRef<readonly TitleEntry[]>([]);
  useEffect(() => {
    titleDictRef.current = (titleDictQ.data?.entries ?? []).map((e) => ({ title: e.title, pageId: e.id }));
    previewViewRef.current?.dispatch({ effects: titleLinksRefresh.of(null) });
  }, [titleDictQ.data]);
  const titleLinks = useMemo<TitleLinkSource | undefined>(() => {
    if (!pageId) return undefined;
    return {
      get dict() { return titleDictRef.current; },
      // navigate re-confirms view at the destination (the /p route's uniform 404) — never a client gate.
      navigate: (id: string) => navigateRouter(`/p/${id}`),
      // Slice B: the hover-card excerpt — the server re-checks view (uniform 404 → null → empty card).
      excerpt: (id: string) =>
        apiFetch<{ title: string; excerpt: string | null }>(`/pages/${encodeURIComponent(id)}/excerpt`, apiToken)
          .catch(() => null),
      opts: { selfPageId: pageId },
    };
  }, [pageId, apiToken, navigateRouter]);
  // #307 / ADR-127: the host-mediated `:::backlinks` source. MEMBER surfaces only (gated on pageId — a
  // template preview / guest surface passes none, so the macro shows the empty-edit placeholder / nothing and
  // never fetches). `fetch` shares the react-query cache (["backlinks", pageId]) with the BacklinksPanel and,
  // being stale-by-default, refetches on each widget mount → re-entering the page yields fresh backlinks
  // (ADR-127 §9 remount freshness; push freshness is out of v1 scope). The endpoint FGA-view-confirms every
  // source for the caller (no new permission surface); navigate re-confirms view at the destination (uniform 404).
  const backlinks = useMemo<BacklinksSource | undefined>(() => {
    if (!pageId) return undefined;
    return {
      // #307 /targetPageId=null ⇒ this page; a string ⇒ that page's backlinks (the endpoint view-gates
      // the target, so a non-viewable/absent id throws → .catch → null → the widget renders nothing).
      fetch: (targetPageId: string | null) => {
        const id = targetPageId ?? pageId;
        return queryClient
          .fetchQuery({
            queryKey: ["backlinks", id],
            queryFn: () => apiFetch<{ id: string; title: string }[]>(`/pages/${encodeURIComponent(id)}/backlinks`, apiToken).then((r) => r ?? []),
          })
          .catch(() => null);
      },
      navigate: (id: string) => navigateRouter(`/p/${id}`),
      emptyLabel: i18n.t("macro.backlinksEmpty"),
      untitledLabel: i18n.t("backlinks.untitled"),
    };
  }, [pageId, apiToken, navigateRouter, queryClient]);
  // Security-timing invalidation (ADR-104 Finding B): the collab server broadcasts a stateless
  // "dict-invalidate" ping (carrying NO pageId — existence-hiding even on the wire); we refetch the
  // viewer-scoped dictionary, throttled so a burst of reindex pings costs one round-trip.
  const dictInvalidateAt = useRef(0);
  const onDictStateless = useCallback((data: { payload: string }) => {
    try {
      if ((JSON.parse(data.payload) as { type?: string })?.type !== "dict-invalidate") return;
    } catch { return; }
    const now = Date.now();
    if (now - dictInvalidateAt.current < 2000) return;
    dictInvalidateAt.current = now;
    void queryClient.invalidateQueries({ queryKey: ["title-dictionary"] });
  }, [queryClient]);

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
    // #224: dictionary invalidation pings ride the existing collab WS as stateless messages.
    c.provider.on("stateless", onDictStateless);
    return () => {
      c.provider.off("stateless", onDictStateless);
      c.disconnect();
      collabRef.current = null;
      awarenessRef.current = null;
    };
    // user intentionally excluded — presence updates go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docName, token, collabUrl, canEdit, onDictStateless]);

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
        ? (index: number, _from: number, checked: boolean) => {
            const c = collabRef.current;
            if (!c) return;
            // #303: the checkbox reports `_from` computed on the PUBLISHED snapshot — NEVER apply it to the
            // live draft (when the draft has diverged, `_from+1` lands on unrelated prose and the optimistic
            // flip + failure-revert overwrite real text; the corruption then syncs to every collaborator via
            // the CRDT). Instead re-resolve the SAME ordinal against the DRAFT (skeletons match ⇒ same index,
            // ADR-019), verify the bracket holds the expected pre-state, and only then flip. If the draft has
            // diverged so the ordinal/pre-state don't line up, write NOTHING — corruption is now structurally
            // impossible; the server 409 (dirty) still guards the published snapshot.
            const expect = checked ? "x" : " "; // the CURRENT (pre-toggle) bracket char
            const next = checked ? " " : "x";
            const flipAt = (pos: number, ch: string) => { c.ytext.delete(pos, 1); c.ytext.insert(pos, ch); };
            const pos = taskStatePosAt(c.ytext.toString(), index);
            if (pos < 0 || c.ytext.toString()[pos] !== expect) {
              // #317: the draft has DIVERGED at the task level (the ordinal/pre-state don't line up). Writing
              // NOTHING is still correct (the #303 corruption guard — never touch the diverged draft), but a
              // SILENT no-op reads as "the checkbox is dead / nothing happened". So still call onToggleTask:
              // the server flushes the draft, its skeleton won't match the published one → 409, and the existing
              // dirty toast fires (member routes.tsx / guest routes.tsx). No local flip ⇒ no revert; onToggleTask
              // shows the toast and re-throws, which we swallow. One shared path — fixes member AND guest.
              void onToggleTask(index).catch(() => {});
              return;
            }
            flipAt(pos, next); // optimistic draft flip, re-located in the DRAFT
            onToggleTask(index).catch(() => {
              const p = taskStatePosAt(c.ytext.toString(), index); // re-resolve for the revert too (offsets moved)
              if (p >= 0 && c.ytext.toString()[p] === next) flipAt(p, expect);
            });
          }
        : undefined;
      const v = mountPublishedView(previewHost, publishedMd ?? "", { resolveImageUrl, resolveAttachment, renderDiagram, resolveTransclude, embedProviders, onToggleTask: onToggleTaskInView, titleLinks, backlinks });
      views.push(v);
      previewViewRef.current = v;
      if (anchorGetterRef) anchorGetterRef.current = null;
      const tocCleanup = wireToc(v, { onHeadings, onActiveHeading, onScrollActivity, tocJumpRef, onTaskProgress }); // #192 TOC (reading/view surface)
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
      resolveAttachment,
      renderDiagram,
      resolveTransclude,
      embedProviders,
      openPageEmbedPicker,
      openEmbedUrlPrompt,
      openTemplateInsertPicker,
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
      titleLinks, // #224: auto internal links (viewer-scoped dictionary; undefined on guest surfaces)
      backlinks, // #307 / ADR-127: host-mediated :::backlinks (member surface; undefined without a pageId)
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
    const tocCleanup = wireToc(previewView, { onHeadings, onActiveHeading, onScrollActivity, tocJumpRef, onTaskProgress }); // #192 TOC (edit surface)

    return () => {
      tocCleanup();
      views.forEach((v) => v.destroy());
      previewViewRef.current = null;
      if (anchorGetterRef) anchorGetterRef.current = null;
      previewHost.replaceChildren();
    };
    // vim excluded (Compartment reconfigure, not a remount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docName, token, collabUrl, surfaceKey, resolveImageUrl, resolveAttachment, renderDiagram, resolveTransclude, embedProviders, openPageEmbedPicker, openEmbedUrlPrompt, openTemplateInsertPicker, onUploadImage, titleLinks]);

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
      {/* #251: "/"-palette Insert template picker. spaceId is null here (the page's space isn't threaded
          into the editor), so the "This space" group shows all space-scope templates the user can view. */}
      <TemplatePickerDialog open={tplInsertOpen} spaceId={null} onClose={() => handleTemplateInsertPick(null)} onPick={handleTemplateInsertPick} />
    </div>
  );
});
