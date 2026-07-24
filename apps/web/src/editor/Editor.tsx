import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { headingsExtension, extractHeadings, type Heading } from "./headings";
import { taskProgressExtension, type TaskProgress } from "./task-progress"; // #290: page task-progress ring
import { connect, connectEphemeral } from "./collab";
import { mountLivePreview, mountPublishedView, vimCompartmentContent, displayModeContent, searchPhrasesContent } from "./editor-livepreview";
import { useTranslation } from "react-i18next";
import { buildSearchPhrases } from "./search-phrases"; // #402 localized CM search-panel phrases
import { wireToc } from "./toc-wiring"; // #319: extracted so the public reader shares the CM TOC wiring
import type { DisplayMode, MacroTheme, ListSource } from "./live-preview/decorations";
import { redrawMacros, taskStatePosAt } from "./live-preview/decorations";
import i18n from "../i18n"; // #307: strings for the host-owned :::backlinks source (i18n stays out of the CM layer)
import { useTheme } from "../app/ThemeProvider";
import { makeMacroPresence } from "./macro-presence";
import { makeResolverSet } from "./resolver-set"; // #381 / ADR-163: the surface declares its context
import { makeLinkStatusResolver } from "./link-status";
import { PageEmbedPicker } from "./PageEmbedPicker";
import { EmbedUrlModal } from "./EmbedUrlModal";
import { TagPickerModal } from "./TagPickerModal";
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
  // #374 TRUE on a guest (share-link) surface. pageId used to double as the member-only-source
  // gate; slice A started passing pageId to the guest mount (for the diagram/transclude resolvers),
  // which silently un-gated the member-only sources (title dictionary / backlinks / query) there — the
  // 2-layer rule says a guest surface must not even INJECT those sources (the server stays the bastion
  // either way). This flag restores the client layer without giving up the guest resolvers.
  guestSurface?: boolean;
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
  onVisibleHeadings?: (froms: number[]) => void; // #345 the light-layer visible set (2-layer TOC highlight)
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
  // edit-capable viewer; absent → checkboxes render disabled. `applyFlip` writes the
  // draft flip over the collab connection — the HOST must run it inside its per-page
  // serial toggle chain, immediately before that toggle's own POST (#361 flipping
  // at click time let a rapid burst pile ≥2 flips into the draft before the first fold,
  // so the server's exactly-one-flip guard 409'd a clean page). A rejection (409
  // dirty/mixed, 403) reverts the optimistic draft flip. Pass a STABLE callback.
  // `checked` = the box's PRE-click state (#361): the host needs it to move the sidebar ring
  // optimistically (that ring reads a server aggregate, not the document).
  onToggleTask?: (index: number, applyFlip: () => void, checked: boolean) => Promise<void>;
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

export const Editor = memo(function Editor({ docName, pageId, guestSurface = false, token, collabUrl, user, capability = "view", apiToken = "", publishedMd = null, editing = false, vim = false, displayMode = "live", onUploadImage, inlineComments, anchorGetterRef, onHeadings, onActiveHeading, onVisibleHeadings, onScrollActivity, tocJumpRef, onTaskProgress, dirtySignal, onExitEdit, onPublish, onToggleTask }: EditorProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme(); // #200: re-render macro widgets (Excalidraw etc.) on a light/dark switch
  const collabRef = useRef<ReturnType<typeof connect> | null>(null);
  const previewViewRef = useRef<EditorView | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  // Owned here so the vim toggle reconfigures the SAME compartment in place.
  const vimCompartment = useRef(new Compartment()).current;
  // ADR-056 / #164: display-mode Compartment, reconfigured in place on a mode switch (no remount).
  const displayModeCompartment = useRef(new Compartment()).current;
  // #402 search-panel phrases Compartment — a language toggle reconfigures in place (no remount).
  const searchPhrasesCompartment = useRef(new Compartment()).current;
  const { t: tSearch } = useTranslation(); // re-renders on language change → searchPhrases recomputes
  const searchPhrases = useMemo(() => buildSearchPhrases(tSearch), [tSearch]);
  const searchPhrasesRef = useRef(searchPhrases);
  searchPhrasesRef.current = searchPhrases;

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

  // #381 / ADR-163: the RESOURCE resolvers come from the one facade — this surface just declares
  // "member/guest page" (guest = same set with the guest token; the server re-gates). Without a pageId
  // diagram/transclude are absent and those macros degrade, exactly as before.
  const { resolveImageUrl, resolveAttachment, renderDiagram, resolveTransclude } = useMemo(
    () => makeResolverSet({ kind: "page", token: apiToken, pageId: pageId ?? null }),
    [apiToken, pageId],
  );
  // #276 / ADR-117: dead-internal-link resolver. Member surfaces only in v1 — gated on the API token (a
  // guest/anon `view` path is a named follow-up, ADR §4), so guests simply see no strikethrough. A
  // page-INTERACTION concern, so it stays caller-supplied (not part of the resolver set).
  const linkStatus = useMemo(() => (apiToken ? makeLinkStatusResolver(apiToken) : undefined), [apiToken]);
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
  // #413 / ADR-145 §5: the `:::tagged` tag picker (same stash/open/resolve pattern). Suggestions inside
  // the modal are the member-only, view-filtered /tags/suggest.
  const [tagPromptOpen, setTagPromptOpen] = useState(false);
  const tagPromptResolve = useRef<((tag: string | null) => void) | null>(null);
  const openTagPrompt = useCallback((onSubmit: (tag: string | null) => void) => {
    tagPromptResolve.current = onSubmit;
    setTagPromptOpen(true);
  }, []);
  const handleTagPick = useCallback((tag: string | null) => {
    setTagPromptOpen(false);
    const r = tagPromptResolve.current;
    tagPromptResolve.current = null;
    r?.(tag);
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

  // #224 / ADR-104 go-live: the viewer-scoped title dictionary. MEMBER surfaces only. #374 the
  // gate is pageId AND NOT guestSurface — pageId alone used to imply "member surface" until the guest
  // mount started passing it (for the diagram/transclude resolvers), which un-gated this member-only
  // fetch there (the title-links-224 guest anti-test). The dictionary is read through a REF so an
  // invalidation refetch updates links in place (titleLinksRefresh) without remounting the editor.
  const navigateRouter = useNavigate();
  const queryClient = useQueryClient();
  const memberPageId = guestSurface ? undefined : pageId; // the member-only-source gate (#374)
  // #413: the view-filtered tag-suggest fetch for the frontmatter chip editor (member surfaces only).
  const tagSuggest = useMemo(() => {
    if (!memberPageId) return undefined;
    return (q: string) =>
      apiFetch<{ tag: string; display: string }[]>(`/tags/suggest?q=${encodeURIComponent(q)}`, apiToken).catch(() => null);
  }, [memberPageId, apiToken]);
  const titleDictQ = useTitleDictionary(memberPageId);
  const titleDictRef = useRef<readonly TitleEntry[]>([]);
  useEffect(() => {
    titleDictRef.current = (titleDictQ.data?.entries ?? []).map((e) => ({ title: e.title, pageId: e.id }));
    previewViewRef.current?.dispatch({ effects: titleLinksRefresh.of(null) });
  }, [titleDictQ.data]);
  const titleLinks = useMemo<TitleLinkSource | undefined>(() => {
    if (!memberPageId) return undefined; // member-only source (#374 pageId alone no longer implies member)
    return {
      get dict() { return titleDictRef.current; },
      // navigate re-confirms view at the destination (the /p route's uniform 404) — never a client gate.
      navigate: (id: string) => navigateRouter(`/p/${id}`),
      // Slice B: the hover-card excerpt — the server re-checks view (uniform 404 → null → empty card).
      excerpt: (id: string) =>
        apiFetch<{ title: string; excerpt: string | null }>(`/pages/${encodeURIComponent(id)}/excerpt`, apiToken)
          .catch(() => null),
      opts: { selfPageId: memberPageId },
    };
  }, [memberPageId, apiToken, navigateRouter]);
  // #370 / ADR-145: the host-mediated `:::tagged` / `:::children` source. MEMBER surfaces only (gated on
  // memberPageId — a guest / template preview passes none (#374 pageId alone no longer implies
  // member), so the macro renders nothing and never fetches; those surfaces get the baked anonymous
  // snapshot server-side). The raw directive body rides to the member-only, view-filtered
  // `GET /pages/:id/list?name=…&body=…`. Stale-by-default fetchQuery keyed on (pageId, name, body) →
  // refetch on each widget mount, so re-entering the page re-resolves the list (member-live per-viewer).
  const list = useMemo<ListSource | undefined>(() => {
    if (!memberPageId) return undefined; // member-only source (#374)
    return {
      fetch: (name: "tagged" | "children", body: string) =>
        queryClient
          .fetchQuery({
            queryKey: ["page-list", memberPageId, name, body],
            queryFn: () => apiFetch<{ id: string; title: string }[]>(`/pages/${encodeURIComponent(memberPageId)}/list?name=${name}&body=${encodeURIComponent(body)}`, apiToken).then((r) => r ?? []),
          })
          .catch(() => null),
      navigate: (id: string) => navigateRouter(`/p/${id}`),
      emptyLabel: i18n.t("macro.listEmpty"),
      untitledLabel: i18n.t("backlinks.untitled"),
    };
  }, [memberPageId, apiToken, navigateRouter, queryClient]);
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
      // #361 per-index flip GENERATION + resync-to-published failure handling. The old revert
      // checked only "does the bracket still hold the char I wrote" and flipped it back — but after a
      // rapid double-click BOTH POSTs can 409 (the two draft flips cancel out before the server folds
      // either), and the second revert then saw its own char (which is ALSO the original state) and
      // "reverted" it, silently flipping the draft AWAY from published (a dirty page out of nowhere —
      // probe-confirmed). Flip-back arithmetic is parity-fragile (N failed flips need N reverts, but
      // superseded handlers must not touch newer state), so failure handling is now: only the LAST
      // outstanding flip for an index acts, and it RESYNCS the draft bracket to the CURRENT PUBLISHED
      // state (the view doc — kept current by the refetch sync) — the invariant a failed toggle must
      // restore, correct for any number of coalesced failures.
      const flipGen = new Map<number, number>();
      const onToggleTaskInView = canEdit && onToggleTask
        ? (index: number, _from: number, checked: boolean) => {
            if (!collabRef.current) return;
            // #303: the checkbox reports `_from` computed on the PUBLISHED snapshot — NEVER apply it to the
            // live draft (when the draft has diverged, `_from+1` lands on unrelated prose and the optimistic
            // flip + failure-revert overwrite real text; the corruption then syncs to every collaborator via
            // the CRDT). Instead re-resolve the SAME ordinal against the DRAFT (skeletons match ⇒ same index,
            // ADR-019), verify the bracket holds the expected pre-state, and only then flip. If the draft has
            // diverged so the ordinal/pre-state don't line up, write NOTHING — corruption is structurally
            // impossible; the server 409 (dirty) still guards the published snapshot and the host's toast fires.
            //
            // #361 the draft write is DEFERRED into `applyFlip`, which the host runs inside its
            // per-page SERIAL toggle chain right before this toggle's own POST. Flipping at click time let a
            // rapid burst pile ≥2 flips into the draft before the server folded the first one, so the
            // exactly-one-flip guard 409'd every request on a CLEAN page ("publish first" out of nowhere).
            // Serialized, each fold sees exactly the one flip it claims. The click-time `checked` (the
            // widget's live pre-click state, which tracks earlier optimistic flips) is still the correct
            // expected pre-state at execution time, because the queued flips land in the same order.
            const expect = checked ? "x" : " "; // the CURRENT (pre-toggle) bracket char
            const next = checked ? " " : "x";
            let myGen = 0; // 0 = we never wrote (diverged no-op) → the failure path has nothing to restore
            const applyFlip = () => {
              const c = collabRef.current;
              if (!c) return;
              const pos = taskStatePosAt(c.ytext.toString(), index);
              // #317: on divergence write NOTHING but still let the POST proceed — the server 409s and the
              // host shows the dirty toast (a silent no-op reads as "the checkbox is dead").
              if (pos < 0 || c.ytext.toString()[pos] !== expect) return;
              c.ytext.delete(pos, 1);
              c.ytext.insert(pos, next);
              myGen = (flipGen.get(index) ?? 0) + 1;
              flipGen.set(index, myGen);
            };
            onToggleTask(index, applyFlip, checked).catch(() => {
              const c = collabRef.current;
              if (!c || myGen === 0) return; // never wrote → nothing to restore
              if (flipGen.get(index) !== myGen) return; // a newer flip superseded ours — it settles the state
              const pubDoc = previewViewRef.current?.state.doc.toString();
              if (pubDoc == null) return;
              const want = pubDoc[taskStatePosAt(pubDoc, index)]; // the bracket state the server still holds
              const p = taskStatePosAt(c.ytext.toString(), index); // re-resolve — draft offsets may have moved
              if (p >= 0 && (want === "x" || want === " ") && c.ytext.toString()[p] !== want) { c.ytext.delete(p, 1); c.ytext.insert(p, want); }
            });
          }
        : undefined;
      const v = mountPublishedView(previewHost, publishedMd ?? "", { resolveImageUrl, resolveAttachment, renderDiagram, resolveTransclude, embedProviders, onToggleTask: onToggleTaskInView, titleLinks, list, linkStatus });
      views.push(v);
      previewViewRef.current = v;
      if (anchorGetterRef) anchorGetterRef.current = null;
      const tocCleanup = wireToc(v, { onHeadings, onActiveHeading, onVisibleHeadings, onScrollActivity, tocJumpRef, onTaskProgress }); // #192 TOC (reading/view surface)
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
      tagSuggest, // #413
      openTagPrompt, // #413
      openTemplateInsertPicker,
      uploadImage: onUploadImage,
      vim,
      vimCompartment,
      displayMode,
      displayModeCompartment,
      searchPhrases: searchPhrasesRef.current,
      searchPhrasesCompartment,
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
      // #502 / ADR-184: the cross-island co-edit seam — the page awareness (co-occupancy roster) + a factory
      // that opens the ephemeral `:x:` room for an island. Gated on a live awareness (this EDIT surface), which
      // INCLUDES edit-authority share-link guests — anonymous real-time co-edit is the north star, and the
      // `:x:` room carries the same server authz gate as Excalidraw (no new trust boundary). No-awareness /
      // no-collab surfaces get undefined → island editors stay private local docs (co-edit also needs 2+).
      coEditHost: c.provider.awareness
        ? {
            awareness: c.provider.awareness as unknown as import("./macro-presence").AwarenessLike,
            connect: (anchor: string) => {
              const session = connectEphemeral({ url: collabUrl, docName, anchor, token });
              try { session.awareness?.setLocalStateField("user", userField(user)); } catch { /* awareness gone */ }
              return session;
            },
          }
        : undefined,
      titleLinks, // #224: auto internal links (viewer-scoped dictionary; undefined on guest surfaces)
      list, // #370 / ADR-145: host-mediated :::tagged / :::children (member surface; undefined without a pageId)
      linkStatus, // #276 / ADR-117: dead-internal-link strikethrough (member surface; undefined for guests)
      selfPageId: pageId, // #325 / ADR-137 slice 2b: "Copy block reference" builds `pageId#^id` (member surface only)
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
    const tocCleanup = wireToc(previewView, { onHeadings, onActiveHeading, onVisibleHeadings, onScrollActivity, tocJumpRef, onTaskProgress }); // #192 TOC (edit surface)

    return () => {
      tocCleanup();
      views.forEach((v) => v.destroy());
      previewViewRef.current = null;
      if (anchorGetterRef) anchorGetterRef.current = null;
      previewHost.replaceChildren();
      // #454: leaving the EDIT surface keeps the collab connection alive (effect 1 — sync must not
      // drop), but the presence THIS surface published must go with it: yCollab's plugin does not
      // null its last `cursor` on destroy, and a macro-modal `macroEdit` anchor has no exit path
      // here — both lingered on every peer until full disconnect. Presence fields only; the
      // provider/Y.Text are untouched (the reconfigure-never-drops-collab invariant). On a FULL
      // unmount this runs just before effect 1's disconnect (setLocalState(null)) — harmless.
      try {
        c.provider.awareness?.setLocalStateField("cursor", null);
        c.provider.awareness?.setLocalStateField("macroEdit", null);
      } catch { /* awareness gone */ }
    };
    // vim excluded (Compartment reconfigure, not a remount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docName, token, collabUrl, surfaceKey, resolveImageUrl, resolveAttachment, renderDiagram, resolveTransclude, embedProviders, openPageEmbedPicker, openEmbedUrlPrompt, openTemplateInsertPicker, onUploadImage, titleLinks, tagSuggest, openTagPrompt]);

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

  // #402 language toggle → reconfigure the search-panel phrases in place (vim-toggle rule:
  // never remounts, collab/presence stay attached). Edit surface only (the panel lives there).
  useEffect(() => {
    const v = previewViewRef.current;
    if (!v || surfaceKey !== "edit") return;
    v.dispatch({ effects: searchPhrasesCompartment.reconfigure(searchPhrasesContent(searchPhrases)) });
  }, [searchPhrases, surfaceKey, searchPhrasesCompartment]);

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
    const cur = v.state.doc.toString();
    if (cur === next) return;
    // #361 dispatch the MINIMAL diff (shared prefix + suffix), NOT a whole-doc replace. A checkbox
    // toggle changes only a couple of chars, so CM keeps every surrounding widget and calls updateDOM on the
    // affected one (the checkbox flips + the :::todo ring animates its stroke-dashoffset in place) instead of
    // rebuilding every widget — which killed the ring transition and made the box bounce on the reading
    // surface (the editor surface already gets minimal Yjs changes, so it animated; this makes view match).
    let s = 0;
    const maxS = Math.min(cur.length, next.length);
    while (s < maxS && cur.charCodeAt(s) === next.charCodeAt(s)) s++;
    let e = 0;
    const maxE = Math.min(cur.length - s, next.length - s);
    while (e < maxE && cur.charCodeAt(cur.length - 1 - e) === next.charCodeAt(next.length - 1 - e)) e++;
    v.dispatch({ changes: { from: s, to: cur.length - e, insert: next.slice(s, next.length - e) } });
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
        {/* #406 min-w-0 — without it this flex item refuses to shrink below its widest child, so a
            wide table pushed the whole editor past the viewport instead of scrolling within it. */}
        <div ref={previewRef} className="flex min-h-0 min-w-0 flex-1 flex-col" />
      </section>
      {/* #205 part 2: the :::embed-page title-search picker (opened from the slash command). */}
      <PageEmbedPicker open={embedPickerOpen} onPick={handleEmbedPick} />
      <EmbedUrlModal open={embedUrlState.open} current={embedUrlState.current} onSubmit={handleEmbedUrl} />
      <TagPickerModal open={tagPromptOpen} onSubmit={handleTagPick} />
      {/* #251: "/"-palette Insert template picker. spaceId is null here (the page's space isn't threaded
          into the editor), so the "This space" group shows all space-scope templates the user can view. */}
      <TemplatePickerDialog open={tplInsertOpen} spaceId={null} onClose={() => handleTemplateInsertPick(null)} onPick={handleTemplateInsertPick} />
    </div>
  );
});
