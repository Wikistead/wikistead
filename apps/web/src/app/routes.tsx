import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes, useParams, useSearchParams, useNavigate } from "react-router-dom";
import { AppShell } from "./AppShell";
import { LoginScreen } from "./LoginScreen";
import { AdminRoutes } from "../settings/AdminPage";
import { AccountRoutes } from "../settings/AccountPage";
import { SpaceSettingsRoutes } from "../settings/SpaceSettingsPage";
import { Editor, type AnchorGetter } from "../editor/Editor";
import { createDirtySignal } from "../editor/dirtySignal";
import { colorFromString } from "../ui/avatar";

// Persisted vim-keymap preference for the single edit surface (Step I). Replaces the
// old single/split layout preference; vim is now a keymap toggle on the one surface.
const KEYMAP_LS = "wks.editorVim";
const readLocalVim = () => { try { return localStorage.getItem(KEYMAP_LS) === "1"; } catch { return false; } };
const writeLocalVim = (on: boolean) => { try { localStorage.setItem(KEYMAP_LS, on ? "1" : "0"); } catch { /* no storage */ } };

// Guest editor keymap (share-link, no member row): localStorage only — there is no
// server profile to sync to.
function useVimPref(): [boolean, () => void] {
  const [vim, setVim] = useState(readLocalVim);
  const toggle = useCallback(() => setVim((v) => { writeLocalVim(!v); return !v; }), []);
  return [vim, toggle];
}

// Member editor keymap (ADR-020 D4 + the startup-mode setting). The cross-device pref is
// a MODE chosen on Account → Editor: 'vim' (always start vim) / 'default' (always start
// off) / 'local' (follow this device's last toolbar toggle, via localStorage). The
// toolbar toggle is always a DEVICE-LOCAL session switch (writes localStorage); for the
// 'vim'/'default' modes startup ignores it (the mode wins), for 'local' it is the source.
function useEditorKeymap(): [boolean, () => void] {
  const settings = useAccountSettings();
  const [vim, setVim] = useState(readLocalVim);
  const mode = settings.data?.editorKeymap; // 'vim' | 'default' | 'local' | undefined (loading)
  useEffect(() => {
    if (!mode) return;
    if (mode === "vim") setVim(true);
    else if (mode === "default") setVim(false);
    else setVim(readLocalVim()); // 'local'
  }, [mode]);
  const toggle = useCallback(() => setVim((v) => { writeLocalVim(!v); return !v; }), []);
  return [vim, toggle];
}

// editor.toggleVim (ADR-021 #2): toggles vim for the current session via the user's
// chosen chord (default Ctrl+Alt+V — a combo vim/the browser don't claim; rebindable to
// dodge AltGr). Window-level so it works whatever has focus while editing; matched by
// event.code so it's layout-robust. Display/editor-core safe.
function useVimToggleShortcut(toggle: () => void, enabled: boolean, chord: string) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (eventMatches(e, chord)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, enabled, chord]);
}
import { PageStatus, PageVim, PageActions, PageControlsMobile, useMediaQuery, type PageControlsProps } from "./PageControls";
import { resolveKey, eventMatches } from "./keybindings";
import type { DisplayMode } from "../editor/live-preview/decorations";

// Editor display mode (ADR-056 / #164), device-local persistence (phase 1: live ⇄ source; a
// server-stored default like the keymap's is a later increment). Orthogonal to vim.
const DISPLAYMODE_LS = "wks.editorDisplayMode";
// The toolbar cycles all four display modes (ADR-056 phase 1: live/source/reading; ADR-078: wysiwyg).
const CYCLE: DisplayMode[] = ["live", "source", "reading", "wysiwyg"];
const nextMode = (m: DisplayMode): DisplayMode => CYCLE[(CYCLE.indexOf(m) + 1) % CYCLE.length] ?? "live";
const readLocalMode = (): DisplayMode => { try { const m = localStorage.getItem(DISPLAYMODE_LS); return (CYCLE as string[]).includes(m ?? "") ? (m as DisplayMode) : "live"; } catch { return "live"; } };
const writeLocalMode = (m: DisplayMode) => { try { localStorage.setItem(DISPLAYMODE_LS, m); } catch { /* no storage */ } };
// #165: NO switch toast. The current mode is ALWAYS visible in the segmented mode-selector (PageControls),
// so a per-switch toast is redundant AND hid content; it also double-fired (a side effect inside the
// setState updater is re-run under React StrictMode). `cycle` (Ctrl+Alt+E) and direct `set` (segment
// click) both just change the device-local mode. Display-only (no doc/offset/presence).
// Guest (share-link, no member row): localStorage only.
function useDisplayMode(): [DisplayMode, () => void, (m: DisplayMode) => void] {
  const [mode, setMode] = useState<DisplayMode>(readLocalMode);
  const set = useCallback((next: DisplayMode) => { writeLocalMode(next); setMode(next); }, []);
  const cycle = useCallback(() => setMode((m) => { const next = nextMode(m); writeLocalMode(next); return next; }), []);
  return [mode, cycle, set];
}
// Member (#164-3): the cross-device STARTUP pref is a MODE on Account → Editor — 'live'/'source'
// (the mode wins at startup) or 'local' (follow this device's last toggle, via localStorage). The
// toolbar toggle is always a device-local session switch. Mirrors useEditorKeymap.
function useMemberDisplayMode(): [DisplayMode, () => void, (m: DisplayMode) => void] {
  const settings = useAccountSettings();
  const [mode, setMode] = useState<DisplayMode>(readLocalMode);
  const pref = settings.data?.editorDisplayMode; // 'live' | 'source' | 'local' | undefined (loading)
  useEffect(() => {
    if (!pref) return;
    if (pref === "live") setMode("live");
    else if (pref === "source") setMode("source");
    else setMode(readLocalMode()); // 'local'
  }, [pref]);
  const set = useCallback((next: DisplayMode) => { writeLocalMode(next); setMode(next); }, []);
  const cycle = useCallback(() => setMode((m) => { const next = nextMode(m); writeLocalMode(next); return next; }), []);
  return [mode, cycle, set];
}
// editor.cycleDisplayMode (ADR-021 #21): window-level, event.code-matched, edit-only — mirrors
// the vim-toggle shortcut. Rebindable; default Ctrl+Alt+E (#165/#166: plain Ctrl-E collided with
// vim's scroll-down — moved off it so vim Ctrl-E scrolls without changing the mode).
function useDisplayModeShortcut(cycle: () => void, enabled: boolean, chord: string) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => { if (eventMatches(e, chord)) { e.preventDefault(); cycle(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle, enabled, chord]);
}
import { PageTitle } from "./PageTitle";
import { Input } from "../ui/Input";
import { ShareDialog } from "../ui/ShareDialog";
import { CommentsPanel } from "../comments/CommentsPanel";
import { Toc } from "../toc/Toc";
import { useTocPref } from "../toc/useTocPref";
import type { Heading } from "../editor/headings";
import { HistoryPanel } from "../history/HistoryPanel";
import { DiffModal } from "../history/DiffModal";
import { PermissionsDialog } from "../ui/PermissionsDialog";
import { Button } from "../ui/Button";
import { notify } from "../ui/toast";
import { useComments } from "../data/comments";
import { Sidebar } from "../sidebar/Sidebar";
import { SearchBox } from "../search/SearchBox";
import { AttachmentsPanel } from "../attachments/AttachmentsPanel";
import { useSession } from "../session/SessionProvider";
import { fetchGuestToken, apiFetch, ApiError, type GuestToken } from "../data/apiClient";
import { usePage, usePublished, usePublish, useRenamePage, useToggleTask, useAccountSettings, useDeletePage, useEntitlements } from "../data/queries";
import { ConfirmDialog } from "../ui/dialogs";
import { uploadAttachment } from "../attachments/useAttachments";
import { downloadPageExport } from "../data/exportApi";
import { useActiveSpace } from "./ActiveSpace";

// Same-origin collab (ADR-016): a relative "/collab" is resolved against the
// current origin to an absolute ws(s):// URL (WebSocket needs an absolute URL),
// so it goes through the same proxy as /api. Absolute ws URLs are used as-is.
function resolveCollabUrl(): string {
  const v = (import.meta as any).env?.VITE_COLLAB_URL ?? "/collab";
  if (/^wss?:\/\//.test(v)) return v;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${v.startsWith("/") ? v : `/${v}`}`;
}
const COLLAB_URL = resolveCollabUrl();

// Member route: /p/:pageId — tenant comes from the session, docName is formed
// the same way the collab server expects ("t:<tenant>:p:<page>").
function PageRoute() {
  const { t } = useTranslation();
  const { pageId } = useParams<{ pageId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const autoEdit = searchParams.get("edit") === "1"; // set by the create-page flow
  // Diff modal is URL-driven (?diff=<revId>): a shallow deep-link (no route added) that
  // restores the open diff on reload, while keeping the editor mounted underneath so
  // presence/collab are untouched (ADR-019).
  const diffRevId = searchParams.get("diff");
  const openDiff = useCallback((revId: string) => setSearchParams((p) => { p.set("diff", revId); return p; }), [setSearchParams]);
  const closeDiff = useCallback(() => setSearchParams((p) => { p.delete("diff"); return p; }), [setSearchParams]);
  const { status, collabToken, tenantId, user, logout, token } = useSession();
  // Capability gates the Edit control (UI only — collab server is the fortress).
  // Defaults to view until resolved, so a page is never editable speculatively. A page
  // that does NOT exist (getPage 404) must never become editable — every page belongs
  // to a space (the page#space premise); a spaceless phantom can be typed into via
  // collab but never published. So we do NOT fall back to edit, and a 404 renders a
  // not-found state (below) rather than an empty editable surface.
  const pageQ = usePage(pageId ?? "");
  const page = pageQ.data;
  const capability = page?.capability ?? "view";

  // Draft/publish: view renders the PUBLISHED snapshot; edit-capable users get a
  // Publish control + an "unpublished changes" indicator.
  const { data: published } = usePublished(pageId ?? "");
  const publish = usePublish(pageId ?? "");
  const renamePage = useRenamePage();

  // Opening any page makes its space the active one, so the sidebar follows —
  // including when arriving from cross-space search or a share link.
  const { setActiveSpaceId } = useActiveSpace();
  const openSpaceId = page?.spaceId;
  useEffect(() => { if (openSpaceId) setActiveSpaceId(openSpaceId); }, [openSpaceId, setActiveSpaceId]);

  // Upload a picked image to this page's space, returning the ref to insert. Bound
  // to the resolved spaceId; null (no image button) until the page meta loads.
  const spaceId = page?.spaceId;
  const qc = useQueryClient();
  const onUploadImage = useCallback(
    async (file: File) => {
      if (!spaceId || !pageId) return null;
      const { id, filename } = await uploadAttachment(spaceId, pageId, token, file);
      // An image inserted/dropped into the doc IS an attachment — refresh the list so it
      // shows in the Attachments panel without a reload (this path uses the bare upload
      // helper, not the mutation, so invalidate explicitly).
      qc.invalidateQueries({ queryKey: ["attachments", pageId] });
      return { ref: `wks-attachment:${id}`, alt: filename };
    },
    [spaceId, pageId, token, qc],
  );

  // Inline-comment integration: the panel and the editor share one comments query.
  // Inline threads (with anchors) become editor highlights; the panel builds inline
  // threads from the editor's current selection via this anchor getter.
  const anchorGetterRef = useRef<AnchorGetter | null>(null);
  // #192 / ADR-091: table of contents. Headings + active section come from the editor (stable
  // callbacks so <Editor>'s memo isn't defeated); the rail's clicks jump via tocJumpRef.
  const { on: tocOn, setOn: setTocOn, depth: tocDepth } = useTocPref();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeHeading, setActiveHeading] = useState<number | null>(null);
  const tocJumpRef = useRef<((from: number) => void) | null>(null);
  const onHeadings = useCallback((h: Heading[]) => setHeadings(h), []);
  const onActiveHeading = useCallback((f: number | null) => setActiveHeading(f), []);
  // #192: scroll-activity fan-out — the editor fires onScrollActivity on each scroll; the narrow-screen
  // TOC overlay subscribes to show itself while scrolling. A ref'd Set (not state) so scrolling never
  // re-renders the route; the callbacks are stable so <Editor>'s memo holds.
  const tocScrollListeners = useRef(new Set<() => void>());
  const onScrollActivity = useCallback(() => { tocScrollListeners.current.forEach((fn) => fn()); }, []);
  const subscribeTocScroll = useCallback((fn: () => void) => { tocScrollListeners.current.add(fn); return () => { tocScrollListeners.current.delete(fn); }; }, []);
  // External dirty store (instant Publish enable) — read only by PageToolbar, written
  // only by the editor's Y.Text observer; never re-renders PageRoute/Editor.
  const dirtySig = useRef(createDirtySignal()).current;
  const { data: threads } = useComments(pageId ?? "");
  // Memoized so host re-renders (published poll, dirty signal) don't hand <Editor> a
  // new array ref and defeat its memo — changes only when the thread set changes.
  const inlineComments = useMemo(() => (threads ?? [])
    .filter((t) => t.kind === "inline" && t.anchorStart && t.anchorEnd)
    .map((t) => ({ threadId: t.id, anchorStart: t.anchorStart!, anchorEnd: t.anchorEnd!, resolved: t.status === "resolved" })), [threads]);
  const openComments = (threads ?? []).filter((t) => t.status === "open").length;

  // Comments panel is toggled (not always-on); the choice persists. Inline blue
  // underlines stay in the editor regardless — the panel is the thread list layer.
  const [commentsOpen, setCommentsOpen] = useState(() => {
    try { return localStorage.getItem("wks.commentsOpen") === "1"; } catch { return false; }
  });
  const toggleComments = () => {
    const willOpen = !commentsOpen;
    setCommentsOpen(willOpen);
    try { localStorage.setItem("wks.commentsOpen", willOpen ? "1" : "0"); } catch { /* no storage */ }
    if (willOpen) closeOtherRightPanels("comments"); // #206: one right panel at a time
  };
  const closeComments = useCallback(() => {
    setCommentsOpen(false);
    try { localStorage.setItem("wks.commentsOpen", "0"); } catch { /* no storage */ }
  }, []);

  // History panel is toggled the same way (persisted). Listing needs view; restore
  // is offered only to edit-capable users (the server re-checks both).
  const [historyOpen, setHistoryOpen] = useState(() => {
    try { return localStorage.getItem("wks.historyOpen") === "1"; } catch { return false; }
  });
  const toggleHistory = () => {
    const willOpen = !historyOpen;
    setHistoryOpen(willOpen);
    try { localStorage.setItem("wks.historyOpen", willOpen ? "1" : "0"); } catch { /* no storage */ }
    if (willOpen) closeOtherRightPanels("history"); // #206: one right panel at a time
  };
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    try { localStorage.setItem("wks.historyOpen", "0"); } catch { /* no storage */ }
  }, []);

  // Attachments: a right-side panel opened on demand from the ⋯ menu (no longer an
  // always-on bottom bar).
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const toggleAttachments = () => {
    const willOpen = !attachmentsOpen;
    setAttachmentsOpen(willOpen);
    if (willOpen) closeOtherRightPanels("attachments"); // #206: one right panel at a time
  };
  const closeAttachments = useCallback(() => setAttachmentsOpen(false), []);

  // #206: mutual exclusion — only one right panel (comments / history / attachments) is open at a time.
  // Opening one closes the others (and clears their persisted-open flag).
  const closeOtherRightPanels = (keep: "comments" | "history" | "attachments") => {
    if (keep !== "comments") { setCommentsOpen(false); try { localStorage.setItem("wks.commentsOpen", "0"); } catch { /* no storage */ } }
    if (keep !== "history") { setHistoryOpen(false); try { localStorage.setItem("wks.historyOpen", "0"); } catch { /* no storage */ } }
    if (keep !== "attachments") setAttachmentsOpen(false);
  };

  // Per-page permissions (manage only). Also the invite-to-draft surface.
  const [permsOpen, setPermsOpen] = useState(false);
  const [sharing, setSharing] = useState(false); // share dialog (current page)
  const [deleting, setDeleting] = useState(false); // delete-page confirm (current page)
  const deletePage = useDeletePage();
  const navigate = useNavigate();

  // Edit mode + layout are owned here now (PageToolbar is the chrome). editing
  // starts true for the create-page flow (?edit=1). layout (single/split) persists.
  const canEdit = capability === "edit";
  const [editing, setEditing] = useState(autoEdit);
  // Navigating to another page opens it in READ mode (unless ?edit=1) — PageRoute is
  // not remounted on a param change, so reset editing when the page changes.
  useEffect(() => { setEditing(autoEdit); dirtySig.set(false); }, [pageId, autoEdit, dirtySig]);
  const [vim, toggleVim] = useEditorKeymap(); // member: startup-mode pref + device-local toggle
  const keybindings = useAccountSettings().data?.keybindings; // ADR-021 overrides ({} default)
  useVimToggleShortcut(toggleVim, editing, resolveKey("editor.toggleVim", keybindings)); // (#2)
  const [displayMode, cycleDisplayMode, setDisplayMode] = useMemberDisplayMode(); // ADR-056 / #164 (startup pref + device-local)
  useDisplayModeShortcut(cycleDisplayMode, editing, resolveKey("editor.cycleDisplayMode", keybindings));
  const isDesktop = useMediaQuery("(min-width: 768px)"); // 3 floating groups vs one ⋯
  const isWide = useMediaQuery("(min-width: 1200px)"); // #192: enough right whitespace for the TOC rail
  // Draft / Unpublished-changes chip (read mode); only meaningful for editors.
  const publishState = !canEdit ? null : published?.publishedMd == null ? "draft" : published?.hasUnpublishedChanges ? "unpublished" : null;

  // Publish = done: flush the draft (server), drop the dirty flag, return to the rendered
  // view. Shared by the toolbar Publish button and the vim :w/:wq ex commands (Light-3).
  const publishPage = useCallback(() => {
    if (!canEdit) return;
    publish.mutate(undefined, {
      onSuccess: () => { dirtySig.set(false); setEditing(false); notify.success(t("toast.published")); },
      onError: () => notify.error(t("toast.publishFailed")),
    });
  }, [canEdit, publish, dirtySig, t]);
  const exitEdit = useCallback(() => setEditing(false), []); // vim :q

  // View-mode task-checkbox toggle (ADR-019). Edit-capable only (D3 UI layer; the
  // server is the bastion). Returns the mutation promise so the editor can revert its
  // optimistic draft flip on failure (409 dirty/mixed, 403); a content edit mixed into
  // the draft is rejected, never silently published. Stable so <Editor>'s memo holds.
  const toggleTask = useToggleTask(pageId ?? "");
  const onToggleTask = useCallback(
    (index: number) =>
      toggleTask.mutateAsync(index).then(() => undefined).catch((e) => {
        notify.error(t("toast.actionFailed"));
        throw e; // let the editor revert the optimistic flip
      }),
    [toggleTask, t],
  );

  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  // A page that doesn't exist (404) or isn't accessible (403) must NOT present an
  // editable phantom surface (it would have no space → unpublishable). Show a clear
  // state inside the member chrome instead.
  if (pageId && pageQ.isError) {
    const code = (pageQ.error as ApiError | undefined)?.status;
    return (
      <AppShell sidebar={<Sidebar />} search={<SearchBox />} onLogout={logout}>
        <div style={{ padding: 24 }} data-testid={code === 403 ? "page-forbidden" : "page-not-found"}>
          {t(code === 403 ? "page.forbidden" : "page.notFound")}
        </div>
      </AppShell>
    );
  }
  const docName = `t:${tenantId}:p:${pageId}`;
  // One props bag drives the floating control groups (status / actions / vim) and the
  // mobile ⋯ — same handlers as the old toolbar, only relocated (behaviour unchanged).
  const controls: PageControlsProps = {
    canEdit,
    editing,
    onEdit: () => setEditing(true),
    onDone: () => setEditing(false),
    publishState,
    canPublish: !!published?.hasUnpublishedChanges,
    onPublish: canEdit ? publishPage : undefined,
    publishing: publish.isPending,
    vim,
    onToggleVim: toggleVim,
    displayMode,
    onCycleDisplayMode: cycleDisplayMode,
    onSetDisplayMode: setDisplayMode,
    // Share + Delete are manage-only (FGA): undefined when the user can't manage, so the
    // ⋯ items / Share button don't render. The server re-checks and 403s regardless
    // (two-layer authz — UI suppression + server enforcement). #4.
    onShare: page?.canManage ? () => setSharing(true) : undefined,
    onDelete: page?.canManage ? () => setDeleting(true) : undefined,
    commentsOpen,
    onToggleComments: toggleComments,
    openComments,
    tocOpen: tocOn,
    onToggleToc: () => setTocOn(!tocOn),
    onHistory: toggleHistory,
    onAttachments: toggleAttachments,
    onExport: () => { if (pageId) void downloadPageExport(token, pageId); },
    onPrint: () => window.print(),
    onPermissions: page?.canManage ? () => setPermsOpen(true) : undefined,
    dirtySignal: dirtySig,
  };
  return (
    <AppShell sidebar={<Sidebar />} search={<SearchBox />} onLogout={logout}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {/* #193 part 3: the header band (title + status) fades DOWN into the content — a semi-
              transparent vertical gradient (opaque at the top → transparent at the bottom) with a
              backdrop-blur, so the boundary dissolves into the editor instead of a hard line (the
              same "blend in + blur" direction as the TOC rail). Token-driven; light/dark via --bg. */}
          <div className="relative z-10 flex-none bg-gradient-to-b from-[var(--bg)] via-[color-mix(in_srgb,var(--bg)_78%,transparent)] to-transparent pb-3 backdrop-blur-[3px]">
            <PageTitle
              editing={editing}
              title={page?.title ?? ""}
              onRename={canEdit && spaceId ? (title) => renamePage.mutate({ pageId: pageId!, spaceId, title }, {
                onSuccess: () => notify.success(t("toast.saved")),
                onError: () => notify.error(t("toast.actionFailed")),
              }) : undefined}
            />
            {/* STATUS group floats under the title, right-aligned (same 740 column). */}
            {isDesktop && <div className="mx-auto flex w-full max-w-[740px] justify-end px-6"><PageStatus {...controls} /></div>}
          </div>
          {/* Editor area is the positioning context for the floating ACTIONS/VIM groups. */}
          <div className="relative" style={{ flex: 1, minHeight: 0 }}>
            <Editor key={docName} docName={docName} pageId={pageId} token={collabToken} collabUrl={COLLAB_URL} user={user} capability={capability} apiToken={token} publishedMd={published?.publishedMd ?? null} editing={editing} vim={vim} displayMode={displayMode} onUploadImage={onUploadImage} inlineComments={inlineComments} anchorGetterRef={anchorGetterRef} onHeadings={onHeadings} onActiveHeading={onActiveHeading} onScrollActivity={onScrollActivity} tocJumpRef={tocJumpRef} dirtySignal={dirtySig} onExitEdit={exitEdit} onPublish={publishPage} onToggleTask={canEdit ? onToggleTask : undefined} />
            {isDesktop ? (<><PageVim {...controls} /><PageActions {...controls} /></>) : <PageControlsMobile {...controls} />}
            {/* #192: the TOC rail lives in the content's RIGHT WHITESPACE, inside the editor area, so the
                scrollbar (the editor's, at the far right) is to the RIGHT of the rail — not between them.
                Positioned absolutely (right-2 clears the scrollbar), only when the viewport is wide enough
                that the centred reading column leaves room. Narrower screens get the scroll overlay. */}
            {isWide && tocOn && (
              <div className="pointer-events-none absolute left-[calc(50%+370px+1rem)] top-2 bottom-2 z-[5] w-[210px]">
                <div className="pointer-events-auto h-full">
                  <Toc headings={headings} activeFrom={activeHeading} depth={tocDepth} onJump={(f) => tocJumpRef.current?.(f)} variant="rail" />
                </div>
              </div>
            )}
            {!isWide && tocOn && <Toc headings={headings} activeFrom={activeHeading} depth={tocDepth} onJump={(f) => tocJumpRef.current?.(f)} variant="overlay" subscribeScroll={subscribeTocScroll} />}
          </div>
        </div>
        {pageId && commentsOpen && <CommentsPanel pageId={pageId} canComment={page?.canComment ?? capability === "edit"} anchorGetterRef={anchorGetterRef} onClose={closeComments} />}
        {pageId && historyOpen && <HistoryPanel pageId={pageId} canRestore={capability === "edit"} onCompare={openDiff} onClose={closeHistory} />}
        {pageId && attachmentsOpen && <AttachmentsPanel pageId={pageId} readOnly={capability !== "edit"} onClose={closeAttachments} />}
      </div>
      {pageId && diffRevId && <DiffModal pageId={pageId} revId={diffRevId} onClose={closeDiff} />}
      {pageId && <PermissionsDialog pageId={pageId} open={permsOpen} onClose={() => setPermsOpen(false)} />}
      <ShareDialog pageId={sharing ? pageId ?? null : null} onClose={() => setSharing(false)} />
      <ConfirmDialog
        open={deleting}
        message={t("sidebar.deletePageConfirm", { name: page?.title ?? "" })}
        onClose={() => setDeleting(false)}
        confirmTestId="confirm-delete-page"
        onConfirm={() => {
          setDeleting(false);
          if (!pageId || !spaceId) return;
          deletePage.mutate(
            { pageId, spaceId },
            {
              // The page is gone — leave it. The home route resolves to a remaining page.
              onSuccess: () => { notify.success(t("toast.pageDeleted")); navigate("/", { replace: true }); },
              onError: () => notify.error(t("toast.actionFailed")),
            },
          );
        }}
      />
    </AppShell>
  );
}

// Guest route: /share/:linkId. The URL carries only the unguessable link id; we
// exchange it for a short-lived guest token at the public landing endpoint, then
// open the editor (read-only for view-capability links). No member chrome.
function ShareRoute() {
  const { t } = useTranslation();
  const { linkId } = useParams<{ linkId: string }>();
  const [state, setState] = useState<{ status: "loading" | "denied" | "ok"; minted?: GuestToken }>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    if (!linkId) {
      setState({ status: "denied" });
      return;
    }
    fetchGuestToken(linkId).then((minted) => {
      if (cancelled) return;
      setState(minted ? { status: "ok", minted } : { status: "denied" });
    });
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  if (state.status === "loading") {
    return <AppShell><div style={{ padding: 16 }}>{t("share.opening")}</div></AppShell>;
  }
  if (state.status === "denied" || !state.minted) {
    return <AppShell><div style={{ padding: 16 }}>{t("share.invalid")}</div></AppShell>;
  }
  // A space link's token carries a space marker docName (t:<tenant>:s:<spaceId>); show the
  // space's pages (#104). A page link goes straight to the page.
  return state.minted.docName.includes(":s:") ? <GuestSpace minted={state.minted} /> : <GuestPage minted={state.minted} />;
}

// Space-link guest landing (#104): list the published pages the space link exposes, then open
// one as a guest page (reusing the SAME space token — the server authorizes in-space pages).
function GuestSpace({ minted }: { minted: GuestToken }) {
  const { t } = useTranslation();
  const { token, docName } = minted;
  const m = /^t:(.+?):s:(.+)$/.exec(docName);
  const tenant = m?.[1] ?? "";
  const spaceId = m?.[2] ?? "";
  const [pages, setPages] = useState<{ id: string; title: string }[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ id: string; title: string }[]>(`/spaces/${encodeURIComponent(spaceId)}/pages`, token)
      .then((r) => { if (!cancelled) setPages(r ?? []); })
      .catch(() => { if (!cancelled) setPages([]); });
    return () => { cancelled = true; };
  }, [spaceId, token]);

  if (openId) {
    // View-only page access via the space token (server re-checks in-space authority).
    const pageMinted: GuestToken = { token, docName: `t:${tenant}:p:${openId}`, capability: "view", readOnly: true };
    return <GuestPage minted={pageMinted} onBack={() => setOpenId(null)} />;
  }
  return (
    <AppShell>
      <div style={{ padding: 16, maxWidth: 640 }}>
        <h2 style={{ marginTop: 0 }}>{t("share.spaceTitle")}</h2>
        {pages == null ? (
          <div>{t("share.opening")}</div>
        ) : pages.length === 0 ? (
          <div style={{ color: "var(--fg-dim)" }}>{t("share.spaceEmpty")}</div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {pages.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  data-testid="guest-space-page"
                  onClick={() => setOpenId(p.id)}
                  style={{ width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer" }}
                >
                  {p.title || t("common.untitled")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}

// The shared page for an anonymous guest (after the link → token exchange). Same
// draft/publish model as members: VIEW links render the PUBLISHED snapshot (no
// collab — the live draft never reaches a view guest's browser); EDIT links join
// the collab draft to co-edit and can Publish. The published content is fetched
// over HTTP with the guest token (the server re-checks the share_link's authority).
function GuestPage({ minted, onBack }: { minted: GuestToken; onBack?: () => void }) {
  const { t } = useTranslation();
  const { token, docName, capability } = minted;
  const pageId = docName.replace(/^t:.+?:p:/, "");
  // Anonymous guest identity (never an OIDC account / seat — the project design notes). Guests have
  // no real name → labelled "Guest"; each session gets a distinct auto colour (no
  // picture) so multiple guests on a doc are still visually distinguishable (#8).
  const [guest] = useState(() => ({ name: t("collab.guest"), color: colorFromString(`guest-${Math.random()}`), picture: null }));
  const [publishedMd, setPublishedMd] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  // #100: guest commenting — canComment (comment_open on the page) decides the composer; comments are
  // page-level for a guest (no inline anchoring — the guest editor isn't wired for anchors). The
  // panel reads/posts with the guest token (routes are guest:'view', re-checked by FGA).
  const [canComment, setCanComment] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const anchorGetterRef = useRef<AnchorGetter | null>(null);
  // #192 / ADR-091: TOC for guests too (device-local pref).
  const { on: tocOn, setOn: setTocOn, depth: tocDepth } = useTocPref();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeHeading, setActiveHeading] = useState<number | null>(null);
  const tocJumpRef = useRef<((from: number) => void) | null>(null);
  const onHeadings = useCallback((h: Heading[]) => setHeadings(h), []);
  const onActiveHeading = useCallback((f: number | null) => setActiveHeading(f), []);
  const tocScrollListeners = useRef(new Set<() => void>()); // #192 scroll fan-out (see PageRoute)
  const onScrollActivity = useCallback(() => { tocScrollListeners.current.forEach((fn) => fn()); }, []);
  const subscribeTocScroll = useCallback((fn: () => void) => { tocScrollListeners.current.add(fn); return () => { tocScrollListeners.current.delete(fn); }; }, []);
  const canEdit = capability === "edit";
  const [editing, setEditing] = useState(false);
  const [vim, toggleVim] = useVimPref();
  useVimToggleShortcut(toggleVim, editing, resolveKey("editor.toggleVim", undefined)); // guest: default chord
  const [displayMode, cycleDisplayMode, setDisplayMode] = useDisplayMode(); // ADR-056 / #164 (device-local; guests have no server profile)
  useDisplayModeShortcut(cycleDisplayMode, editing, resolveKey("editor.cycleDisplayMode", undefined));
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const isWide = useMediaQuery("(min-width: 1200px)"); // #192: right whitespace for the TOC rail

  const reloadPublished = useCallback(() => {
    apiFetch<{ publishedMd: string | null; canComment?: boolean }>(`/pages/${encodeURIComponent(pageId)}/published`, token)
      .then((r) => { setPublishedMd(r?.publishedMd ?? null); setCanComment(!!r?.canComment); })
      .catch(() => { /* denied/expired → empty view */ });
  }, [pageId, token]);
  useEffect(() => { reloadPublished(); }, [reloadPublished]);

  const onPublish = async () => {
    setPublishing(true);
    try {
      await apiFetch(`/pages/${encodeURIComponent(pageId)}/publish`, token, { method: "POST" });
      notify.success(t("toast.published"));
      setEditing(false); // publish = done → back to the rendered view
    } catch {
      notify.error(t("toast.publishFailed"));
    }
    setPublishing(false);
    reloadPublished();
  };

  const controls: PageControlsProps = {
    canEdit,
    editing,
    onEdit: () => setEditing(true),
    onDone: () => setEditing(false),
    vim,
    onToggleVim: toggleVim,
    displayMode,
    onCycleDisplayMode: cycleDisplayMode,
    onSetDisplayMode: setDisplayMode,
    canPublish: true,
    onPublish: canEdit ? () => void onPublish() : undefined,
    publishing,
    // #100: comments toggle — shown to any guest who can VIEW (reading is guest:'view'); the composer
    // inside the panel is gated on canComment (comment_open). openComments count is member-only chrome.
    commentsOpen,
    onToggleComments: () => setCommentsOpen((o) => !o),
    tocOpen: tocOn,
    onToggleToc: () => setTocOn(!tocOn),
  };
  return (
    <AppShell>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        {onBack && (
          <button type="button" onClick={onBack} data-testid="guest-space-back" style={{ alignSelf: "flex-start", margin: "8px 12px 0", padding: "4px 8px", background: "transparent", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer" }}>
            ← {t("share.backToSpace")}
          </button>
        )}
        <div className="relative flex min-h-0" style={{ flex: 1 }}>
          <div className="relative min-w-0 flex-1">
            <Editor key={docName} docName={docName} token={token} collabUrl={COLLAB_URL} user={guest} capability={capability} apiToken={token} publishedMd={publishedMd} editing={editing} vim={vim} displayMode={displayMode} onHeadings={onHeadings} onActiveHeading={onActiveHeading} onScrollActivity={onScrollActivity} tocJumpRef={tocJumpRef} />
            <div className="pointer-events-none absolute right-3 top-3 z-10"><PageStatus {...controls} /></div>
            {isDesktop ? (<><PageVim {...controls} /><PageActions {...controls} /></>) : <PageControlsMobile {...controls} />}
            {/* #192: TOC rail in the content's right whitespace (scrollbar stays rightmost); overlay narrower. */}
            {isWide && tocOn && (
              <div className="pointer-events-none absolute left-[calc(50%+370px+1rem)] top-2 bottom-2 z-[5] w-[210px]">
                <div className="pointer-events-auto h-full">
                  <Toc headings={headings} activeFrom={activeHeading} depth={tocDepth} onJump={(f) => tocJumpRef.current?.(f)} variant="rail" />
                </div>
              </div>
            )}
            {!isWide && tocOn && <Toc headings={headings} activeFrom={activeHeading} depth={tocDepth} onJump={(f) => tocJumpRef.current?.(f)} variant="overlay" subscribeScroll={subscribeTocScroll} />}
          </div>
          {commentsOpen && <CommentsPanel pageId={pageId} canComment={canComment} anchorGetterRef={anchorGetterRef} onClose={() => setCommentsOpen(false)} token={token} />}
        </div>
      </div>
    </AppShell>
  );
}

// Cloud signup landing (platform origin). Public — no session yet. Starts the
// platform-IdP flow as a top-level navigation to /signup/login (proxied to the API).
function JoinRoute() {
  const { t } = useTranslation();
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>{t("auth.joinTitle")}</h2>
        <p style={{ color: "var(--fg-dim)" }}>{t("auth.joinBody")}</p>
        <Button variant="primary" onClick={() => { window.location.href = "/signup/login"; }}>{t("auth.signUp")}</Button>
      </div>
    </AppShell>
  );
}

// After platform-IdP signup: choose a workspace name → POST /signup/tenants (uses
// the signup session cookie) → redirect to the new tenant subdomain, where the
// member logs in via platform-IdP SSO (a fresh host-only member session there).
function WorkspaceRoute() {
  const { t } = useTranslation();
  const [slug, setSlug] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    const res = await fetch("/signup/tenants", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    if (res.ok) {
      const { tenantUrl } = (await res.json()) as { tenantUrl: string };
      window.location.href = tenantUrl;
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setErr(body.error ?? t("auth.createWorkspaceError"));
    setBusy(false);
  };
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>{t("auth.workspaceTitle")}</h2>
        <p style={{ color: "var(--fg-dim)" }}>{t("auth.workspaceBody")}</p>
        <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t("auth.workspacePlaceholder")} aria-label={t("auth.workspaceName")} />
        {err && <p style={{ color: "crimson" }}>{err}</p>}
        <Button variant="primary" disabled={busy || !slug} onClick={submit}>{t("auth.createWorkspace")}</Button>
      </div>
    </AppShell>
  );
}

// Invite acceptance landing: the link carries ?token. Accepting starts the OIDC
// login with the token attached (?invite=) — the callback accepts the invite and
// seats the user (the new membership grant). The token is opaque to the SPA.
function InviteRoute() {
  const { t } = useTranslation();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const accept = () => {
    window.location.href = `/auth/login?invite=${encodeURIComponent(token)}&returnTo=${encodeURIComponent("/p/demo")}`;
  };
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>{t("auth.inviteTitle")}</h2>
        <p style={{ color: "var(--fg-dim)" }}>{t("auth.inviteBody")}</p>
        <Button variant="primary" disabled={!token} onClick={accept}>{t("auth.acceptInvite")}</Button>
      </div>
    </AppShell>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/p/:pageId" element={<PageRoute />} />
      <Route path="/share/:linkId" element={<ShareRoute />} />
      <Route path="/invite" element={<InviteRoute />} />
      {AdminRoutes()}
      {AccountRoutes()}
      {SpaceSettingsRoutes()}
      {/* Back-compat: the old members URL now lives under the admin console. */}
      <Route path="/settings/members" element={<Navigate to="/admin/members" replace />} />
      <Route path="/join" element={<JoinRoute />} />
      <Route path="/join/workspace" element={<WorkspaceRoute />} />
      {/* Dev default: the seeded demo page. Real landing/space routing is a
          next-stage screen. */}
      <Route path="*" element={<Navigate to="/p/demo" replace />} />
    </Routes>
  );
}
