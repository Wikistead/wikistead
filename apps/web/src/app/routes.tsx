import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes, useParams, useSearchParams, useNavigate, Link as RouterLink } from "react-router-dom";

// #489: route-based code splitting. The admin console, account settings, space settings and the login
// screen are OFF the initial editor path, so they load from their own chunks behind a Suspense
// boundary instead of riding the eager main bundle. Behaviour is unchanged — same paths, same
// components; only the load moment moves (a brief fallback on first navigation to each subtree).
const AdminRoot = lazy(() => import("../settings/AdminPage").then((m) => ({ default: m.AdminRoot })));
const AccountRoot = lazy(() => import("../settings/AccountPage").then((m) => ({ default: m.AccountRoot })));
const SpaceSettingsRoot = lazy(() => import("../settings/SpaceSettingsPage").then((m) => ({ default: m.SpaceSettingsRoot })));
// A minimal, chrome-free fallback for a lazy subtree (the chunk loads in well under a frame on a warm
// cache; this only shows on the very first navigation to that area).
function LazyFallback() {
  const { t } = useTranslation();
  return <div style={{ padding: 24, color: "var(--fg-dim)" }}>{t("common.loading")}</div>;
}
import { AppShell } from "./AppShell";
import { LoginScreen } from "./LoginScreen";




import { Editor, type AnchorGetter } from "../editor/Editor";
import { PageAnalyticsPanel } from "./PageAnalyticsPanel"; // #464 / ADR-175
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
// #289 / ADR-115: the member's editor CHROME visibility — which display modes the switch/cycle
// offer and whether the vim toggle button shows. null editorChrome (never enrolled) = all shown.
// Display-only personal preference; guests (no member settings) always get the full chrome.
function useEditorChrome(): { showVimToggle: boolean; visibleModes: DisplayMode[] } {
  const settings = useAccountSettings();
  const chrome = settings.data?.editorChrome ?? null;
  return useMemo(() => {
    const mv = chrome?.modesVisible;
    const visible = mv ? CYCLE.filter((m) => mv[m]) : CYCLE;
    // Never let a broken/all-false object strand the user with zero modes (fail open to all).
    return { showVimToggle: chrome?.vimToggleVisible ?? true, visibleModes: visible.length > 0 ? visible : CYCLE };
  }, [chrome]);
}
// Member (#164-3): the cross-device STARTUP pref is a MODE on Account → Editor — 'live'/'source'/
// 'wysiwyg' (#289 widened the startup catalog) or 'local' (follow this device's last toggle, via
// localStorage). The toolbar toggle is always a device-local session switch. #289: the boot mode is
// clamped to the VISIBLE set, and the Ctrl+Alt+E cycle SKIPS hidden modes (ADR-115 §3 — "disable a
// hidden mode's shortcut" = exclude it from the cycle array).
function useMemberDisplayMode(visibleModes: DisplayMode[]): [DisplayMode, () => void, (m: DisplayMode) => void] {
  const settings = useAccountSettings();
  const [mode, setMode] = useState<DisplayMode>(readLocalMode);
  const pref = settings.data?.editorDisplayMode; // 'live' | 'source' | 'wysiwyg' | 'local' | undefined (loading)
  const visKey = visibleModes.join(",");
  useEffect(() => {
    if (!pref) return;
    const boot = pref === "live" || pref === "source" || pref === "wysiwyg" ? pref : readLocalMode(); // 'local'
    setMode(visibleModes.includes(boot) ? boot : visibleModes[0] ?? "live");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pref, visKey]);
  const set = useCallback((next: DisplayMode) => { writeLocalMode(next); setMode(next); }, []);
  const cycle = useCallback(() => setMode((m) => {
    // walk the canonical CYCLE order but land only on VISIBLE modes (hidden ones are skipped)
    let next = m;
    for (let i = 0; i < CYCLE.length; i++) {
      next = nextMode(next);
      if (visibleModes.includes(next)) break;
    }
    writeLocalMode(next);
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [visKey]);
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
import { Home, Lock, Snowflake } from "lucide-react";
import { useHeadingHashLanding, replaceHashWith } from "../toc/useHashLanding"; // #313: #<slug> deep links
import { PageTitle } from "./PageTitle";
import { PageMeta } from "./PageMeta";
import { ProgressRing } from "./ProgressRing"; // #290: title-band page-progress ring
import { useTheme } from "./ThemeProvider"; // #376: public reader remounts on theme switch (diagram re-render)
import { ThemeToggle } from "./ThemeToggle"; // #429/#430: the standalone public reader's header controls
import { LanguageToggle } from "./LanguageToggle";
import { RelatedPanel } from "./RelatedPanel";
import { Input } from "../ui/Input";
import { ShareDialog } from "../ui/ShareDialog";
import { CommentsPanel } from "../comments/CommentsPanel";
import { TocChrome } from "../toc/TocChrome"; // #227: shared TOC rail/overlay/toggle wiring (member + public)
import { useTocPref } from "../toc/useTocPref";
import type { Heading } from "../editor/headings";
import { HistoryPanel } from "../history/HistoryPanel";
import { DiffModal } from "../history/DiffModal";
import { PermissionsDialog } from "../ui/PermissionsDialog";
import { Button } from "../ui/Button";
import { ProseSkeleton, useDelayedFlag } from "../ui/Skeleton";
import { notify } from "../ui/toast";
import { useComments } from "../data/comments";
import { Sidebar } from "../sidebar/Sidebar";
import { PageTree, type PageTreeNode } from "../sidebar/PageTree"; // #227: reuse the member page tree in the public reader
import { SearchBox } from "../search/SearchBox";
import { AttachmentsPanel } from "../attachments/AttachmentsPanel";
import { useSession } from "../session/SessionProvider";
import { fetchGuestToken, apiFetch, assetUrl, type GuestToken } from "../data/apiClient";
import { usePage, usePublished, usePublish, useRenamePage, useToggleTask, useAccountSettings, useDeletePage, useDirectDeletePage, useCreatePage, useEntitlements, useSpaces, useBranding, type Page } from "../data/queries";
import { TenantBrand } from "./BrandLockup"; // #430 the public header uses the shared two-slot lockup
import { Avatar } from "../ui/Avatar"; // #430 the public header's space chip (shared primitive)
import { GuestSidebar } from "./GuestSidebar";
import { ConfirmDialog } from "../ui/dialogs";
import { DeleteBacklinkWarning } from "./DeleteBacklinkWarning";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
import { TemplatesRoute } from "./TemplatesPage";
import { RecentChangesRoute } from "./RecentChangesPage";
import { WatchListRoute } from "../notifications/WatchListPage"; // #362: bell → watch-management list
import { uploadAttachment } from "../attachments/useAttachments";
import { downloadPageExport, printPageHtml } from "../data/exportApi";
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
// #364 / ADR-157: `pageIdOverride` lets the space-root route /spaces/:id) render the HOME page with
// the full page machinery (view/edit/publish/history/collab) without a second implementation; the
// param path additionally canonicalises /p/<home-id> → /spaces/:id (one location for the home).
// #457: what fills the body area before the real content can. Until now both states drew NOTHING, so a
// page still fetching was indistinguishable from a page with nothing written in it. Loading → a skeleton
// (gated by useDelayedFlag so a fast load never flashes it); resolved-and-blank → an explicit empty state.
// An overlay, not a replacement: the Editor stays mounted underneath so collab/presence are untouched
// (the project design notes: a reconfigure/remount must never drop them), and it never intercepts clicks.
// #457 the overlay must actually COVER the editor — inset-0 (full height, not just the top edge)
// with an OPAQUE page background (var(--bg)) so the mounted-but-still-resolving Editor never shows
// through. Before this it was inset-x-0/top-0 and transparent, so the instant the editor began painting
// content (before showSkeleton flipped false) the skeleton and the real body were both visible = the
// overlap. It sits below the title band (z-20) so the band stays crisp, and above the editor.
function BodyPlaceholder({ loading, empty, canEdit }: { loading: boolean; empty: boolean; canEdit: boolean }) {
  const { t } = useTranslation();
  const showSkeleton = useDelayedFlag(loading);
  if (!showSkeleton && !empty) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[1] flex justify-center bg-[var(--bg)]"
      // the surface pads its content top by exactly --wks-band-h (tokens.css: the band overlays the
      // scroller), so matching it puts the first bar on the first line of prose.
      style={{ paddingTop: "var(--wks-band-h, 0px)" }}
      data-testid="body-placeholder"
      data-state={showSkeleton ? "loading" : "empty"}
    >
      {/* the reading column: same 740px measure + horizontal padding as .cm-content (tokens.css), so
          the bars sit exactly where the first lines of prose will and nothing shifts on replacement. */}
      <div className="w-full max-w-[740px] px-[var(--space-5)]">
        {showSkeleton ? (
          <ProseSkeleton />
        ) : (
          <p className="mt-1 text-sm text-fg-dim" data-testid="page-empty">
            {canEdit ? t("page.emptyEditable") : t("page.empty")}
          </p>
        )}
      </div>
    </div>
  );
}

// #364 ②: the guest and public shells drew a bare div (or a "loading" text line) while resolving,
// so opening a share/public link flashed a blank page. Reuse the member skeleton machinery: ProseSkeleton
// behind useDelayedFlag (a fast resolve never flashes it), in the same 740px reading column the content
// lands in, so nothing shifts on replacement.
function ShellLoading() {
  const show = useDelayedFlag(true);
  return (
    <div className="flex justify-center" data-testid="shell-loading">
      <div className="w-full max-w-[740px] px-[var(--space-5)] pt-10">{show ? <ProseSkeleton /> : null}</div>
    </div>
  );
}

function PageRoute({ pageIdOverride, homeSpaceName }: { pageIdOverride?: string; homeSpaceName?: string } = {}) {
  const { t } = useTranslation();
  const params = useParams<{ pageId: string }>();
  const pageId = pageIdOverride ?? params.pageId;
  const spacesForHome = useSpaces();
  const homeOwner = !pageIdOverride && pageId ? (spacesForHome.data ?? []).find((s) => s.homePageId === pageId) : undefined;
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
  const publishedQ = usePublished(pageId ?? "");
  const published = publishedQ.data;
  const publish = usePublish(pageId ?? "");
  const renamePage = useRenamePage();

  // Opening any page makes its space the active one, so the sidebar follows
  // including when arriving from cross-space search or a share link.
  const { setActiveSpaceId } = useActiveSpace();
  const openSpaceId = page?.spaceId;
  useEffect(() => { if (openSpaceId) setActiveSpaceId(openSpaceId); }, [openSpaceId, setActiveSpaceId]);

  // #336 part B: the sidebar's unpublished-changes dot reads from the ["pages"] list, which has NO poll
  // so a fresh draft edit did not surface on the dot until a reload. usePublished already polls the OPEN
  // page's persisted draft-vs-published state (presence-safe: it's a SERVER poll, never an editor React
  // signal — driving unpublished/dirty UI from an editor signal regressed the presence e2e, memory
  // editor-dirty-presence-constraint). When it transitions to "unpublished", invalidate the pages list
  // ONCE so the sidebar dot appears within the poll interval, without touching the editor render path.
  const dirty = published?.hasUnpublishedChanges ?? false;
  const openSpaceForDirty = page?.spaceId;
  const prevDirtyRef = useRef(false);
  const qcForDirty = useQueryClient();
  useEffect(() => {
    if (dirty && !prevDirtyRef.current && openSpaceForDirty) qcForDirty.invalidateQueries({ queryKey: ["pages", openSpaceForDirty] });
    prevDirtyRef.current = dirty;
  }, [dirty, openSpaceForDirty, qcForDirty]);

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
  const [visibleHeadings, setVisibleHeadings] = useState<number[]>([]); // #345 light-layer set
  const tocJumpRef = useRef<((from: number) => void) | null>(null);
  const onHeadings = useCallback((h: Heading[]) => setHeadings(h), []);
  const onActiveHeading = useCallback((f: number | null) => setActiveHeading(f), []);
  const onVisibleHeadings = useCallback((f: number[]) => setVisibleHeadings(f), []);
  // #313: /p/:id#<slug> deep link — once the doc's headings include the hash slug, land on it via the
  // same band-aware TOC jump a rail click uses.
  const tocJump = useCallback((f: number) => tocJumpRef.current?.(f), []);
  useHeadingHashLanding(headings, tocJump);
  // #290 / ADR-114 (A): the page's live GFM-checkbox progress → a ring in the title band. Editor fires this
  // (display-only, dedup'd, like onHeadings — NOT the dirty-signal path), the title band shows it.
  const [taskProgress, setTaskProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const onTaskProgress = useCallback((p: { done: number; total: number }) => setTaskProgress(p), []);
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
  // ADR-102: useComments is now an infinite query — flatten the loaded pages to the thread list. (Inline
  // comments were removed in #214 part 1, so inlineComments is always empty now; openComments is a
  // member-only count chrome reflecting the LOADED threads — exact for the common < one-page case.)
  const threadList = useMemo(() => (threads?.pages ?? []).flatMap((p) => p?.threads ?? []), [threads]);
  // Memoized so host re-renders (published poll, dirty signal) don't hand <Editor> a
  // new array ref and defeat its memo — changes only when the thread set changes.
  const inlineComments = useMemo(() => threadList
    .filter((t) => t.kind === "inline" && t.anchorStart && t.anchorEnd)
    .map((t) => ({ threadId: t.id, anchorStart: t.anchorStart!, anchorEnd: t.anchorEnd!, resolved: t.status === "resolved" })), [threadList]);
  const openComments = threadList.filter((t) => t.status === "open").length;

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

  // #322 / ADR-133: the "Related" panel (was "Backlinks" #230) — a right-rail panel opened from the ⋯ menu,
  // now a section container (§Backlinks 1-hop today; 2-hop / graph / tags slot in later). Openable in both
  // modes; part of the #206 mutual exclusion.
  const [relatedOpen, setRelatedOpen] = useState(false);
  const toggleRelated = () => {
    const willOpen = !relatedOpen;
    setRelatedOpen(willOpen);
    if (willOpen) closeOtherRightPanels("related");
  };
  const closeRelated = useCallback(() => setRelatedOpen(false), []);

  // #206: mutual exclusion — only one right panel (comments / history / attachments / related) is open
  // at a time. Opening one closes the others (and clears their persisted-open flag).
  const closeOtherRightPanels = (keep: "comments" | "history" | "attachments" | "related") => {
    if (keep !== "comments") { setCommentsOpen(false); try { localStorage.setItem("wks.commentsOpen", "0"); } catch { /* no storage */ } }
    if (keep !== "history") { setHistoryOpen(false); try { localStorage.setItem("wks.historyOpen", "0"); } catch { /* no storage */ } }
    if (keep !== "attachments") setAttachmentsOpen(false);
    if (keep !== "related") setRelatedOpen(false);
  };

  // Per-page permissions (manage only). Also the invite-to-draft surface.
  const [permsOpen, setPermsOpen] = useState(false);
  const [sharing, setSharing] = useState(false); // share dialog (current page)
  const [deleting, setDeleting] = useState(false); // delete-page confirm (current page)
  const [deletingForever, setDeletingForever] = useState(false); // #437: direct permanent confirm
  const [savingTemplate, setSavingTemplate] = useState(false); // #248: "Save as template" dialog
  const deletePage = useDeletePage();
  const directDeletePage = useDirectDeletePage();
  // #437 / ADR-167: the space's resolved deletion-pathway policy shapes which delete entries the ⋯
  // menu offers (UI only — the server routes gate regardless).
  const activeSpace = useSpaces().data?.find((s) => s.id === spaceId);
  const deleteMode = activeSpace?.deleteMode ?? "trash_only";
  const duplicatePage = useCreatePage(); // #229/#242: "Duplicate page" → new page seeded from this one
  const navigate = useNavigate();

  // Edit mode + layout are owned here now (PageToolbar is the chrome). editing
  // starts true for the create-page flow (?edit=1). layout (single/split) persists.
  const canEdit = capability === "edit";
  const [editing, setEditing] = useState(autoEdit);
  // Navigating to another page opens it in READ mode (unless ?edit=1) — PageRoute is
  // not remounted on a param change, so reset editing when the page changes.
  useEffect(() => { setEditing(autoEdit); dirtySig.set(false); }, [pageId, autoEdit, dirtySig]);
  // #464 / ADR-175: signal ONE genuine READ per page open in VIEW mode (not the polled /published fetch,
  // not an edit open) so analytics counts readers, not editor-openers. Fires once per pageId (PageRoute is
  // not remounted on a param change, so a ref keyed on pageId gates it); the server view-gates + dedups.
  const viewSignaledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pageId || editing || viewSignaledRef.current === pageId) return;
    viewSignaledRef.current = pageId;
    apiFetch(`/pages/${encodeURIComponent(pageId)}/view`, token, { method: "POST" }).catch(() => {});
  }, [pageId, editing, token]);
  const [vim, toggleVim] = useEditorKeymap(); // member: startup-mode pref + device-local toggle
  const keybindings = useAccountSettings().data?.keybindings; // ADR-021 overrides ({} default)
  useVimToggleShortcut(toggleVim, editing, resolveKey("editor.toggleVim", keybindings)); // (#2)
  const { showVimToggle, visibleModes } = useEditorChrome(); // #289 / ADR-115: per-user chrome visibility
  const [displayMode, cycleDisplayMode, setDisplayMode] = useMemberDisplayMode(visibleModes); // ADR-056 / #164 (startup pref + device-local)
  useDisplayModeShortcut(cycleDisplayMode, editing, resolveKey("editor.cycleDisplayMode", keybindings));
  const isDesktop = useMediaQuery("(min-width: 768px)"); // 3 floating groups vs one ⋯
  const isWide = useMediaQuery("(min-width: 1200px)"); // #192: enough right whitespace for the TOC rail
  // #406 S4 / ADR-159 (e): a coarse pointer (touch = soft keyboard) forces the EFFECTIVE vim off
  // vim breaks soft-keyboard input. The stored preference is untouched (vim returns on a fine-pointer
  // device); the Compartment reconfigure in Editor swaps keymaps in place (collab/presence unbroken).
  // #512: WYSIWYG mode joins the same forced-off seam — vim × WYSIWYG is a bug nest (#240 atomic-skip),
  // so vim is inert while WYSIWYG is active and returns (from the stored pref) on leaving it.
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const vimForcedOff = coarsePointer || displayMode === "wysiwyg";
  const effectiveVim = vim && !vimForcedOff;
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
    (index: number, applyFlip: () => void, checked: boolean) =>
      toggleTask.mutateAsync({ index, applyFlip, checked }).then(() => undefined).catch((e) => {
        // #303: a 409 is the EXPECTED outcome when the draft has unpublished changes — the checkbox can't
        // fold into published without mixing in that draft. Show a dedicated message, not the generic error.
        // Read `.status` STRUCTURALLY, not via `instanceof ApiError`: under Vite dev the apiClient module can
        // be duplicated across graphs so the class identity mismatches and instanceof is false at runtime
        // (#303 review defect — the dedicated toast never showed).
        // #361 the two 409s are told apart by their static code. `task_burst` is a TRANSIENT — a
        // faster click already stacked a flip — so it is swallowed: no toast, and no rethrow, because
        // rethrowing runs the editor's draft-revert and undoes what the user is looking at. The refetch
        // that follows the burst is the reconciliation. Only `task_draft_dirty` (real unpublished prose)
        // keeps the "publish first" message and the revert.
        const err = e as { status?: number; code?: string } | null;
        if (err?.status === 409 && err.code === "task_burst") return undefined;
        const dirty = err?.status === 409;
        notify.error(t(dirty ? "toast.taskToggleDirty" : "toast.actionFailed"));
        throw e; // let the editor revert the optimistic flip
      }),
    [toggleTask, t],
  );
  // #212 bounce 3 (comment 720): the header band OVERLAPS the scrolling editor (absolute overlay) so its
  // backdrop-blur has content behind it; the editor clears it via a padding-top equal to the band height,
  // published as the --wks-band-h CSS var by this ResizeObserver. React 19 callback ref with cleanup.
  // MUST be declared BEFORE the early returns below — a hook after a conditional return breaks the
  // rules-of-hooks (the "rendered fewer hooks" crash).
  const bandRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const set = () => parent.style.setProperty("--wks-band-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); parent.style.removeProperty("--wks-band-h"); };
  }, []);

  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  // A page that doesn't exist or isn't accessible must NOT present an editable phantom surface (it would
  // have no space → unpublishable). #262: the server now returns a uniform 404 for both "no such page" and
  // "no view access" (existence-hiding), so the client shows ONE not-found state — a
  // message would leak that the page exists.
  if (pageId && pageQ.isError) {
    return (
      <AppShell sidebar={<Sidebar />} search={<SearchBox />} onLogout={logout}>
        <div style={{ padding: 24 }} data-testid="page-not-found">{t("page.notFound")}</div>
      </AppShell>
    );
  }
  // #364 / ADR-157 §4: /p/<home-id> canonicalises to the space root (one location for the home).
  if (homeOwner) return <Navigate to={`/spaces/${homeOwner.id}`} replace />;
  const docName = `t:${tenantId}:p:${pageId}`;
  // One props bag drives the floating control groups (status / actions / vim) and the
  // mobile ⋯ — same handlers as the old toolbar, only relocated (behaviour unchanged).
  const controls: PageControlsProps = {
    canEdit,
    // #490: a real page whose capability has not resolved yet (navigation / first load). Keep the edit
    // slot stable rather than collapsing to view-only and tearing the button out on every page switch.
    capabilityPending: !!pageId && pageQ.isPending,
    editing,
    onEdit: () => setEditing(true),
    onDone: () => setEditing(false),
    pageId, // #320 / ADR-126: enables the watch (🔔) toggle (member surface only — the guest shell omits it)
    spaceId, // #362: enables the space-scope watch item
    publishState,
    canPublish: !!published?.hasUnpublishedChanges,
    onPublish: canEdit ? publishPage : undefined,
    publishing: publish.isPending,
    vim: effectiveVim,
    vimForcedOff, // #512: coarse pointer OR WYSIWYG
    onToggleVim: toggleVim,
    displayMode,
    onCycleDisplayMode: cycleDisplayMode,
    onSetDisplayMode: setDisplayMode,
    // #289 / ADR-115: per-user chrome visibility (display-only; Ctrl+Alt+V still toggles vim even
    // with the button hidden — the keymap setting is the recovery point, never a dead-end).
    showVimToggle,
    visibleModes,
    // Share + Delete are manage-only (FGA): undefined when the user can't manage, so the
    // ⋯ items / Share button don't render. The server re-checks and 403s regardless
    // (two-layer authz — UI suppression + server enforcement). #4.
    onShare: page?.canManage ? () => setSharing(true) : undefined,
    onDelete: page?.canManage && deleteMode !== "direct_only" ? () => setDeleting(true) : undefined,
    onDeleteForever: page?.canManage && (deleteMode === "both" || deleteMode === "direct_only") ? () => setDeletingForever(true) : undefined,
    // #229: create a new page in this space seeded with this page's published content, and open it
    // in edit mode. Needs a resolved space + an edit-capable user (the server view-gates the source
    // and 403s a non-editor of the destination space regardless).
    onDuplicate: spaceId && pageId && canEdit ? () => {
      duplicatePage.mutate(
        { spaceId, title: `${page?.title ?? "Untitled"} (copy)`, fromPageId: pageId },
        { onSuccess: (p: { id: string } | null) => { if (p) navigate(`/p/${p.id}?edit=1`); } },
      );
    } : undefined,
    // #248: save this page's published content as a reusable template. Any member viewing the page may
    // save (the server view-gates the source + rejects guests); the item is disabled for a draft-only page.
    onSaveTemplate: spaceId && pageId ? () => setSavingTemplate(true) : undefined,
    commentsOpen,
    onToggleComments: toggleComments,
    openComments,
    tocOpen: tocOn,
    onToggleToc: () => setTocOn(!tocOn),
    onHistory: toggleHistory,
    onAttachments: toggleAttachments,
    onRelated: pageId ? toggleRelated : undefined,
    onExport: () => { if (pageId) void downloadPageExport(token, pageId); },
    // #85 bounce: the HTML-export UI entry is SEALED until the post-launch Option-A redesign (a
    // DOM-free render core shared by client + SSR). The current renderMarkdownToHtml output is
    // low-fidelity (math `$$` leaks as raw text, table/callout/embed diverge, dark theme). Per the
    // user, the menu item stays VISIBLE but GRAYED OUT (disabled) rather than hidden — see
    // PageControls (export-html item is disabled). The handler is kept for when the redesign re-enables it.
    onExportHtml: () => { if (pageId) void downloadPageExport(token, pageId, "html"); },
    // #207 part 2: print the full server-rendered HTML (all macros static, no raw ::: leak) rather
    // than window.print on the virtualised CM surface. Fall back to the live-surface print only when
    // the page has no exportable HTML (unpublished draft → 404), so drafts can still be printed.
    onPrint: () => {
      if (pageId) void printPageHtml(token, pageId).then((ok) => { if (!ok) window.print(); });
      else window.print();
    },
    onPermissions: page?.canManage ? () => setPermsOpen(true) : undefined,
    dirtySignal: dirtySig,
  };
  return (
    <AppShell sidebar={<Sidebar />} search={<SearchBox />} onLogout={logout}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {/* #406 minWidth 0 all the way down. A flex item defaults to min-width:auto, so a wide
            child (a table, a long code line) widened the whole editor pane instead of scrolling inside
            it — on a phone the pane laid out at 667px in a 390px window and <main>'s overflow-hidden
            simply cut the rest off. */}
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0 }}>
          {/* Editor area is the positioning context for the floating ACTIONS/VIM groups AND the header
              band overlay (#212 bounce 3). */}
          <div className="relative" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            {/* #193 part 3 / #212 bounce 2+3: the header band (title + status) fades DOWN into the content
                — a SEMI-TRANSPARENT vertical gradient (translucent top → transparent bottom) with a
                backdrop-blur. It is ABSOLUTELY positioned over the TOP of the scrolling editor so content
                scrolls UNDER it and the frosted effect actually shows (iOS-navbar style); a flow sibling
                sat above the scroller with zero overlap, so nothing was ever behind the blur (comment 720).
                pointer-events-none on the band + auto on its content lets clicks through the transparent
                gradient to the editor's first lines while keeping the title interactive. The editor pads
                its top by --wks-band-h (set by bandRef) so line 1 clears the band. Token-driven (--bg),
                light/dark. */}
            {/* #212 comment 769 (1): the frosted FADE and the CONTENT are SEPARATE layers. The mask-image
                that dissolves the boundary (comment 755) must only fade the BACKGROUND (gradient +
                backdrop-blur) — putting it on the whole band also dimmed the title/badge/toggle. So the
                frosted layer is an absolute, masked, aria-hidden sibling BEHIND the content; the content
                layer sits above it (relative), crisp and 100% opaque. pb-6 = the fade zone below the row. */}
            <div ref={bandRef} className="pointer-events-none absolute inset-x-0 top-0 z-20 pb-6">
              {/* #212 comment 780 (1): the frosted layer stops 10px short of the right edge (the scrollbar
                  gutter, --wks-sbw=10px in tokens.css) so backdrop-blur never blurs the scrollbar thumb. */}
              <div aria-hidden="true" className="absolute inset-y-0 left-0 right-2.5 bg-gradient-to-b from-[color-mix(in_srgb,var(--bg)_90%,transparent)] via-[color-mix(in_srgb,var(--bg)_42%,transparent)] to-transparent backdrop-blur-md [mask-image:linear-gradient(to_bottom,black_50%,transparent)]" />
              {/* #212 comment 755 (2): title + status share ONE row (was title, then status BELOW = 2 lines
                  tall). The 740px reading column + top padding live here now; the title flexes and the status
                  (unpublished badge + TOC toggle) sits at the row's right. --wks-band-h shrinks accordingly,
                  and the CM top padding + TOC overlay offset follow it automatically (bandRef ResizeObserver). */}
              <div className="pointer-events-auto relative mx-auto flex w-full max-w-[740px] items-center gap-3 px-6 pt-6">
                {/* #109 Fix B: private (allowlist-only) lock beside the title. Only viewers of the page see it. */}
                {page?.private && <Lock size={16} className="mt-1 flex-none self-start text-fg-dim" data-testid="title-private-lock" aria-label={t("sidebar.private")} />}
                {/* #329 / ADR-139: freeze badge (staged edit lock) beside the title. Shown to any viewer
                    freeze only removes access, so the badge reveals nothing; the title attribute names the level. */}
                {page?.frozen && (
                  <Snowflake size={16} className="mt-1 flex-none self-start text-fg-dim" data-testid="title-frozen-badge"
                    aria-label={page.frozen === "full" ? t("page.frozenFull") : t("page.frozenGuests")}>
                    <title>{page.frozen === "full" ? t("page.frozenFull") : t("page.frozenGuests")}</title>
                  </Snowflake>
                )}
                <div className="min-w-0 flex-1">
                  {/* #364 the space HOME's title is derived from the space name and locked
                      no rename affordance (pageIdOverride is only ever set when rendering the home at
                      /spaces/:id, and /p/<home-id> canonicalises there). The server refuses the PATCH
                      too (two-layer defense).
                      #364 the home label interpolates the SPACE NAME, never `page.title`. Under
                      ruling A the stored title IS the space name, but a home created before that
                      ruling still carries the baked-in suffix ("<Space>"), and feeding THAT into
                      the label produced the doubled "<Space>". The sidebar 🏠 always used
                      space.name (and read correctly) — this makes the band use the same single source, so
                      no stored title can ever double the suffix again. Migration 077 backfills the old
                      rows so search / pins / export agree with what is displayed. */}
                  <PageTitle
                    title={pageIdOverride ? t("spaceHome.title", { name: homeSpaceName ?? activeSpace?.name ?? "" }) : page?.title ?? ""}
                    onRename={canEdit && spaceId && !pageIdOverride ? (title) => renamePage.mutate({ pageId: pageId!, spaceId, title }, {
                      onSuccess: () => notify.success(t("toast.saved")),
                      onError: () => notify.error(t("toast.actionFailed")),
                    }) : undefined}
                  />
                  {/* #222: creator / last-publisher / updated-time, directly under the title.
                      #290 (A): a page-progress ring rides the meta row when the page has any checkboxes. */}
                  <div className="flex items-center gap-2">
                    <PageMeta createdBy={page?.createdBy} updatedBy={page?.updatedBy} updatedAt={page?.updatedAt} createdByName={page?.createdByName} createdByHasAvatar={page?.createdByHasAvatar} updatedByName={page?.updatedByName} updatedByHasAvatar={page?.updatedByHasAvatar} />
                    {/* #361 (4): PageMeta carries its own mt-1 top margin; match it on the ring so
                        items-center aligns the ring to the meta TEXT centre, not the taller margin-box — the ring
                        rode ~2px high against a SINGLE meta line (the 2-line case already looked centred). */}
                    {/* #361 point 3: animKey keeps the band ring animating across surface remounts too. */}
                    {/* the band ring and every sidebar tree ring are the SAME component, so the
                        shared page-task-ring testid cannot address this one — give the band its own. */}
                    <span className="mt-1 inline-flex self-center" data-testid="band-task-ring"><ProgressRing done={taskProgress.done} total={taskProgress.total} animKey={pageId} /></span>
                  </div>
                </div>
                {/* #406 PageStatus stays at every width. It carries the TOC toggle AND the
                    draft / unpublished badges, so gating it on isDesktop hid the publish state of a
                    page from anyone on a phone — while the public reader showed the same control
                    unconditionally, making the member view the odd one out. */}
                <div className="shrink-0"><PageStatus {...controls} /></div>
              </div>
            </div>
            <BodyPlaceholder
              loading={(pageQ.isLoading || publishedQ.isLoading) && !editing}
              empty={!editing && !pageQ.isLoading && !publishedQ.isLoading && !(published?.publishedMd ?? "").trim()}
              canEdit={canEdit}
            />
            <Editor key={docName} docName={docName} pageId={pageId} token={collabToken} collabUrl={COLLAB_URL} user={user} capability={capability} apiToken={token} publishedMd={published?.publishedMd ?? null} editing={editing} vim={effectiveVim} displayMode={displayMode} onUploadImage={onUploadImage} inlineComments={inlineComments} anchorGetterRef={anchorGetterRef} onHeadings={onHeadings} onActiveHeading={onActiveHeading} onVisibleHeadings={onVisibleHeadings} onScrollActivity={onScrollActivity} tocJumpRef={tocJumpRef} onTaskProgress={onTaskProgress} dirtySignal={dirtySig} onExitEdit={exitEdit} onPublish={publishPage} onToggleTask={canEdit ? onToggleTask : undefined} />
            {/* #464 / ADR-175: the who-viewed analytics panel — a MANAGER-only reading affordance (the
                server 403s a non-manager, 404s a non-viewer; this only renders when the caller manages the
                page and is reading, not editing). */}
            {page?.canManage && !editing && pageId && <PageAnalyticsPanel pageId={pageId} />}
            {isDesktop ? (<><PageVim {...controls} /><PageActions {...controls} /></>) : <PageControlsMobile {...controls} />}
            {/* #192: the TOC rail lives in the content's RIGHT WHITESPACE, inside the editor area, so the
                scrollbar (the editor's, at the far right) is to the RIGHT of the rail — not between them.
                Positioned absolutely (right-2 clears the scrollbar), only when the viewport is wide enough
                that the centred reading column leaves room. Narrower screens get the scroll overlay.
                #212: the rail shares the RIGHT zone with the comments/history/attachments panels, so it
                yields (hidden) when one is open — else its pointer-events overlap and swallow clicks on
                the panel (a right panel and the rail must not both occupy the zone). */}
            {/* #227 the shared TocChrome (rail on wide / overlay on narrow). The member toggle lives in
                the controls bar, so no floating toggle here. The rail yields (railEnabled) when a right panel
                shares its zone, else their pointer-events overlap and swallow clicks on the panel. */}
            <TocChrome
              headings={headings}
              activeFrom={activeHeading}
              visibleFroms={visibleHeadings}
              depth={tocDepth}
              // #313: reflect the jumped-to heading in the URL (hash-only replaceState — shareable, no history spam)
              onJump={(f) => { tocJumpRef.current?.(f); const h = headings.find((x) => x.from === f); if (h) replaceHashWith(h.slug); }}
              subscribeScroll={subscribeTocScroll}
              isWide={isWide}
              tocOn={tocOn}
              railEnabled={!commentsOpen && !historyOpen && !attachmentsOpen && !relatedOpen}
            />
          </div>
        </div>
        {pageId && commentsOpen && <CommentsPanel pageId={pageId} canComment={page?.canComment ?? capability === "edit"} anchorGetterRef={anchorGetterRef} onClose={closeComments} />}
        {pageId && historyOpen && <HistoryPanel pageId={pageId} canRestore={capability === "edit"} canModerate={page?.canModerate ?? false} onCompare={openDiff} onClose={closeHistory} />}
        {pageId && attachmentsOpen && <AttachmentsPanel pageId={pageId} readOnly={capability !== "edit"} onClose={closeAttachments} />}
        {pageId && relatedOpen && <RelatedPanel pageId={pageId} onClose={closeRelated} />}
      </div>
      {pageId && diffRevId && <DiffModal pageId={pageId} revId={diffRevId} onClose={closeDiff} />}
      {pageId && <PermissionsDialog pageId={pageId} open={permsOpen} onClose={() => setPermsOpen(false)} />}
      <ShareDialog pageId={sharing ? pageId ?? null : null} onClose={() => setSharing(false)} />
      <SaveTemplateDialog
        open={savingTemplate}
        pageId={savingTemplate ? pageId ?? null : null}
        spaceId={spaceId ?? null}
        defaultName={page?.title ?? ""}
        onClose={() => setSavingTemplate(false)}
      />
      <ConfirmDialog
        open={deleting}
        message={t("sidebar.deletePageConfirm", { name: page?.title ?? "" })}
        warning={<DeleteBacklinkWarning pageId={deleting ? pageId ?? null : null} onNavigate={() => setDeleting(false)} />}
        onClose={() => setDeleting(false)}
        confirmTestId="confirm-delete-page"
        onConfirm={() => {
          setDeleting(false);
          if (!pageId || !spaceId) return;
          deletePage.mutate(
            { pageId, spaceId },
            {
              // The page is gone — leave it. The home route resolves to a remaining page.
              onSuccess: () => { notify.success(t("toast.pageTrashed")); navigate("/", { replace: true }); },
              onError: () => notify.error(t("toast.actionFailed")),
            },
          );
        }}
      />
      {/* #437 / ADR-167: irreversible — typed confirmation (the page title) gates the button. */}
      <ConfirmDialog
        open={deletingForever}
        title={t("sidebar.deleteForeverTitle")}
        message={t("sidebar.deleteForeverConfirm", { name: page?.title || t("common.untitled") })}
        confirmLabel={t("sidebar.deleteForever")}
        confirmTestId="confirm-delete-page-forever"
        typedConfirmText={page?.title || t("common.untitled")}
        warning={<DeleteBacklinkWarning pageId={deletingForever ? pageId ?? null : null} onNavigate={() => setDeletingForever(false)} />}
        onClose={() => setDeletingForever(false)}
        onConfirm={() => {
          setDeletingForever(false);
          if (!pageId || !spaceId) return;
          directDeletePage.mutate(
            { pageId, spaceId },
            {
              onSuccess: () => { notify.success(t("toast.pageDeletedForever")); navigate("/", { replace: true }); },
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
  // #233 / ADR-107: FOUR states — loading / denied (dead link) / password_required (a live password link) /
  // ok. The password prompt re-POSTs the mint with the entry; a wrong one lands back on password_required
  // with a generic error (wrong ≡ missing — no oracle). #233 a 429 (wrong-password throttle) keeps
  // the prompt with a cool-down notice ("throttled") instead of dropping to the dead-link view.
  const [state, setState] = useState<{ status: "loading" | "denied" | "password" | "ok"; minted?: GuestToken; error?: "wrong" | "throttled" }>({
    status: "loading",
  });
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const attempt = useCallback((pw?: string) => {
    if (!linkId) { setState({ status: "denied" }); return; }
    setSubmitting(true);
    fetchGuestToken(linkId, pw).then((minted) => {
      setSubmitting(false);
      // A submitted attempt: a wrong password lands back on the prompt with the generic error; a 429
      // keeps the prompt with the cool-down notice (never the dead-link view — the user just typed).
      if (minted === "password_required") setState({ status: "password", error: "wrong" });
      else if (minted === "rate_limited") setState({ status: "password", error: "throttled" });
      else setState(minted ? { status: "ok", minted } : { status: "denied" });
    });
  }, [linkId]);

  useEffect(() => {
    let cancelled = false;
    if (!linkId) { setState({ status: "denied" }); return; }
    // First attempt with no password: a non-password link returns a token; a password link returns
    // password_required (→ show the prompt) without the user typing anything they don't need to. This
    // prompt-display POST is NOT counted by the wrong-password throttle (#233, server-side).
    fetchGuestToken(linkId).then((minted) => {
      if (cancelled) return;
      if (minted === "password_required") setState({ status: "password" });
      else if (minted === "rate_limited") setState({ status: "password", error: "throttled" });
      else setState(minted ? { status: "ok", minted } : { status: "denied" });
    });
    return () => { cancelled = true; };
  }, [linkId]);

  if (state.status === "loading") {
    // #364 ②: skeleton instead of a text line — same machinery as the member body placeholder.
    return <AppShell><ShellLoading /></AppShell>;
  }
  if (state.status === "password") {
    return (
      <AppShell>
        <div className="mx-auto mt-16 flex max-w-sm flex-col gap-3 p-4" data-testid="share-password-form">
          <h2 className="text-[length:var(--text-lg)] font-semibold">{t("share.passwordTitle")}</h2>
          <p className="text-fg-dim">{t("share.passwordPrompt")}</p>
          <form onSubmit={(e) => { e.preventDefault(); if (password) attempt(password); }} className="flex flex-col gap-2">
            <Input type="password" value={password} autoFocus aria-label={t("share.passwordLabel")} data-testid="share-password-input" onChange={(e) => setPassword(e.target.value)} />
            {state.error === "wrong" && <p className="text-[var(--danger)]" data-testid="share-password-error">{t("share.passwordWrong")}</p>}
            {state.error === "throttled" && <p className="text-[var(--danger)]" data-testid="share-password-throttled">{t("share.passwordThrottled")}</p>}
            <Button variant="primary" type="submit" disabled={!password || submitting} data-testid="share-password-submit">{t("share.passwordSubmit")}</Button>
          </form>
        </div>
      </AppShell>
    );
  }
  if (state.status === "denied" || !state.minted) {
    return <AppShell><div style={{ padding: 16 }}>{t("share.invalid")}</div></AppShell>;
  }
  // A space link's token carries a space marker docName (t:<tenant>:s:<spaceId>); show the
  // space's pages (#104). A page link goes straight to the page.
  return state.minted.docName.includes(":s:") ? <GuestSpace minted={state.minted} /> : <GuestPage minted={state.minted} />;
}

// Space-link guest reader-chrome (#245 / ADR-112): show the linked space's page tree in the REAL sidebar
// slot — the guest browses exactly like a member — then open a page in the content area. The tree comes
// from GET /spaces/:id/pages (guest-capable, per-page FGA-gated on the share_link principal), synthesised
// from the token's single space; the member-only GET /spaces is never called (Decision 0). No member
// chrome (switcher/settings/create/rename/delete/unpublished dots) — GuestSidebar renders a read-only tree.
// (Ships only after #244, which stops private pages from appearing in a space-guest's tree.)
function GuestSpace({ minted }: { minted: GuestToken }) {
  const { t } = useTranslation();
  const { token, docName, capability } = minted;
  const m = /^t:(.+?):s:(.+)$/.exec(docName);
  const tenant = m?.[1] ?? "";
  const spaceId = m?.[2] ?? "";
  const [pages, setPages] = useState<Page[] | null>(null);
  // #500: a failed tree fetch used to be swallowed into an EMPTY tree (`.catch( => setPages([]))`), so an
  // FGA outage read as "this space has no pages" and derailed real-reviews. Track the error separately
  // so the sidebar can say "couldn't load, retry" instead of lying about emptiness.
  const [pagesError, setPagesError] = useState(false);
  const [space, setSpace] = useState<{ name: string; iconImageUrl: string | null; homePageId?: string | null } | null>(null);
  const landedHome = useRef(false); // #364 ①: default-land on the home ONCE (never re-hijack navigation)
  const [openId, setOpenId] = useState<string | null>(null);

  const refreshPages = useCallback(() => {
    setPagesError(false);
    apiFetch<Page[]>(`/spaces/${encodeURIComponent(spaceId)}/pages`, token)
      .then((r) => setPages(r ?? []))
      .catch(() => setPagesError(true));
  }, [spaceId, token]);

  // #274 / ADR-135 (review ruling): the guest "new page" affordance (edit links only) uses
  // the MEMBER operation model — click → a blank "Untitled" page immediately → open straight in edit
  // mode; naming happens in the editor title band. Created PUBLISHED atomically server-side. 429 = the
  // created-page cap — a static cool-down notice (no limit detail: the server sends a reason code only).
  const [createdId, setCreatedId] = useState<string | null>(null); // start the editor in edit for a page WE just created
  const createGuestPage = useCallback(async () => {
    try {
      const page = await apiFetch<Page>(`/spaces/${encodeURIComponent(spaceId)}/pages`, token, {
        method: "POST",
        body: JSON.stringify({ title: "Untitled" }), // the member new-page literal (Sidebar.tsx newPage) — byte parity
      });
      refreshPages();
      if (page) { setCreatedId(page.id); setOpenId(page.id); }
    } catch (e) {
      notify.error(t((e as { status?: number }).status === 429 ? "share.newPageRateLimited" : "share.newPageFailed"));
    }
  }, [spaceId, token, refreshPages, t]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Page[]>(`/spaces/${encodeURIComponent(spaceId)}/pages`, token)
      .then((r) => { if (!cancelled) setPages(r ?? []); })
      .catch(() => { if (!cancelled) { setPages([]); setPagesError(true); } }); // #500: error ≠ empty
    // #270: the space header (name + public icon only) so the guest sidebar shows the real space, not a
    // fixed "Shared space" label. Best-effort — a failure just falls back to the label.
    apiFetch<{ name: string; iconImageUrl: string | null; homePageId?: string | null }>(`/spaces/${encodeURIComponent(spaceId)}/info`, token)
      .then((r) => {
        if (cancelled || !r) return;
        setSpace(r);
        // #364 ①: guest default landing = the space home (member §6a parity), only when the server
        // exposed a VIEW-GATED pointer and the guest hasn't opened anything yet.
        if (r.homePageId && !landedHome.current) { landedHome.current = true; setOpenId((prev) => prev ?? r.homePageId!); }
      })
      .catch(() => { /* keep the fallback label */ });
    return () => { cancelled = true; };
  }, [spaceId, token]);

  // The page opens via the SAME space token; the server re-checks in-space authority. Edit-capable space
  // links carry their capability into the page (Decision 2/C — the tree is read-only chrome, but a page
  // opened from an edit link is editable); view links open read-only.
  const pageMinted: GuestToken | null = openId
    ? { token, docName: `t:${tenant}:p:${openId}`, capability, readOnly: capability !== "edit" }
    : null;

  return (
    <AppShell
      sidebar={<GuestSidebar pages={pages ?? []} loading={pages == null && !pagesError} space={space ?? undefined} openId={openId} onOpen={setOpenId} onCreate={capability === "edit" ? createGuestPage : undefined} homePageId={space?.homePageId ?? null} error={pagesError} onRetry={refreshPages} />}
      // #449 / ADR-173: the guest gets the SAME search box (Ctrl-K + the header field), wired to their
      // own token and opening hits inside this shell via the tree's open handler. The server forces the
      // link's space scope and gates every hit on the share_link principal — no member chrome leaks here.
      search={<SearchBox guestToken={token} onNavigate={setOpenId} />}
    >
      {pageMinted ? (
        // key on the page id so switching pages in the tree remounts the editor cleanly. A page this
        // guest JUST created opens straight in edit mode (member new-page parity); onTitleChange
        // refreshes the tree so the rename shows up without a reload.
        <GuestPageContent key={openId} minted={pageMinted} startEditing={openId === createdId} onTitleChange={refreshPages} />
      ) : pages == null ? (
        // #364 ②: still resolving (tree + home pointer) — skeleton, not a centred text line.
        <ShellLoading />
      ) : (
        <div className="flex h-full items-center justify-center p-8 text-center text-fg-dim" data-testid="guest-space-welcome">
          {t("share.spacePickPrompt")}
        </div>
      )}
    </AppShell>
  );
}

// The shared page for an anonymous guest (after the link → token exchange). Same
// draft/publish model as members: VIEW links render the PUBLISHED snapshot (no
// collab — the live draft never reaches a view guest's browser); EDIT links join
// the collab draft to co-edit and can Publish. The published content is fetched
// over HTTP with the guest token (the server re-checks the share_link's authority).
// The guest page CONTENT (no AppShell) — reused both by the page-link route (GuestPage, wrapped in a
// chrome-less AppShell) and by the space-link reader-chrome (GuestSpace, rendered inside an AppShell whose
// sidebar is the guest page tree). Keeping the AppShell out of here lets the space layout own a single
// shell with the sidebar slot (#245 / ADR-112).
function GuestPageContent({ minted, onBack, startEditing = false, onTitleChange }: { minted: GuestToken; onBack?: () => void; startEditing?: boolean; onTitleChange?: () => void }) {
  const { t } = useTranslation();
  const { token, docName, capability } = minted;
  const pageId = docName.replace(/^t:.+?:p:/, "");
  // Anonymous guest identity (never an OIDC account / seat — the project design notes). Guests have
  // no real name → labelled "Guest"; each session gets a distinct auto colour (no
  // picture) so multiple guests on a doc are still visually distinguishable (#8).
  const [guest] = useState(() => ({ name: t("collab.guest"), color: colorFromString(`guest-${Math.random()}`), picture: null }));
  const [publishedMd, setPublishedMd] = useState<string | null>(null);
  // #457 has the FIRST /published fetch settled? Until it has, the body area is "loading", not
  // "empty" — the same distinction the member surface draws. Set on BOTH resolve and deny/expire (a
  // denied guest sees the empty view, not an eternal skeleton).
  const [publishedLoaded, setPublishedLoaded] = useState(false);
  const [pageTitle, setPageTitle] = useState(""); // #318: shown in the guest title band (read-only)
  // #364 a space's HOME page is labelled by its space everywhere else — the sidebar's 🏠 row, the
  // member band, the empty state. The guest band printed the raw title, which migration 077 normalised to
  // the bare space name, so the same page read "Acme" here and "Acme Home" one pane away. The label is
  // built from the title the guest already has; the server sends a boolean, never the space name (a
  // single-page share link should not disclose the space behind it).
  const [isHome, setIsHome] = useState(false);
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
  const [visibleHeadings, setVisibleHeadings] = useState<number[]>([]); // #345 light-layer set
  const tocJumpRef = useRef<((from: number) => void) | null>(null);
  const onHeadings = useCallback((h: Heading[]) => setHeadings(h), []);
  const onActiveHeading = useCallback((f: number | null) => setActiveHeading(f), []);
  const onVisibleHeadings = useCallback((f: number[]) => setVisibleHeadings(f), []);
  // #313: /share/:linkId#<slug> deep link (same device as the member surface).
  const tocJump = useCallback((f: number) => tocJumpRef.current?.(f), []);
  useHeadingHashLanding(headings, tocJump);
  const tocScrollListeners = useRef(new Set<() => void>()); // #192 scroll fan-out (see PageRoute)
  const onScrollActivity = useCallback(() => { tocScrollListeners.current.forEach((fn) => fn()); }, []);
  const subscribeTocScroll = useCallback((fn: () => void) => { tocScrollListeners.current.add(fn); return () => { tocScrollListeners.current.delete(fn); }; }, []);
  const canEdit = capability === "edit";
  // a page the guest just created opens straight in edit mode (member new-page parity).
  const [editing, setEditing] = useState(startEditing && capability === "edit");
  const [vim, toggleVim] = useVimPref();
  useVimToggleShortcut(toggleVim, editing, resolveKey("editor.toggleVim", undefined)); // guest: default chord
  const [displayMode, cycleDisplayMode, setDisplayMode] = useDisplayMode(); // ADR-056 / #164 (device-local; guests have no server profile)
  useDisplayModeShortcut(cycleDisplayMode, editing, resolveKey("editor.cycleDisplayMode", undefined));
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const isWide = useMediaQuery("(min-width: 1200px)"); // #192: right whitespace for the TOC rail
  // #406 S4: same coarse-pointer vim force-off as the member surface (ADR-159 (e)).
  // #512: WYSIWYG also forces vim off (member-surface parity) — vim × WYSIWYG is a bug nest.
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const vimForcedOff = coarsePointer || displayMode === "wysiwyg";
  const effectiveVim = vim && !vimForcedOff;

  const reloadPublished = useCallback(() => {
    apiFetch<{ title?: string; isHome?: boolean; publishedMd: string | null; canComment?: boolean }>(`/pages/${encodeURIComponent(pageId)}/published`, token)
      .then((r) => { setPublishedMd(r?.publishedMd ?? null); setPageTitle(r?.title ?? ""); setIsHome(!!r?.isHome); setCanComment(!!r?.canComment); })
      .catch(() => { /* denied/expired → empty view */ })
      .finally(() => setPublishedLoaded(true));
  }, [pageId, token]);
  useEffect(() => { reloadPublished(); }, [reloadPublished]);
  // #464 / ADR-175: a view-guest's genuine READ is signalled once per page open (view mode) — the server
  // view-gates it (guest tokens carry `view`) and aggregates it (guests are never named in the roster).
  const viewSignaledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pageId || editing || viewSignaledRef.current === pageId) return;
    viewSignaledRef.current = pageId;
    apiFetch(`/pages/${encodeURIComponent(pageId)}/view`, token, { method: "POST" }).catch(() => {});
  }, [pageId, editing, token]);

  // #274 EDIT-capability guests rename via the same title band as members (naming happens in the
  // editor — guest pages are created "Untitled"). The server re-checks FGA edit on the guest token.
  const renameGuestPage = useCallback((title: string) => {
    apiFetch<{ title: string }>(`/pages/${encodeURIComponent(pageId)}`, token, { method: "PATCH", body: JSON.stringify({ title }) })
      .then((r) => { setPageTitle(r?.title ?? title); notify.success(t("toast.saved")); onTitleChange?.(); })
      .catch(() => notify.error(t("toast.actionFailed")));
  }, [pageId, token, t, onTitleChange]);

  // #318: publish the guest band's ACTUAL height as --wks-band-h on the editor's positioning parent
  // the same ResizeObserver contract as the member surface (#212 bounce 3), so the CM top padding, the
  // TOC overlay offsets and the anchor/TOC jump clearance (#304/#313 headerBandPx) all follow it.
  const bandRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const set = () => parent.style.setProperty("--wks-band-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); parent.style.removeProperty("--wks-band-h"); };
  }, []);

  // #317: view-mode task-checkbox toggle for an EDIT-capability guest (ADR-019) — the server route
  // already accepts guest:'edit'; only this client wiring was missing. Same contract as the member
  // path (#303): throw on failure so the editor reverts its optimistic draft flip; a 409 (dirty
  // draft) gets the dedicated toast (status read STRUCTURALLY — instanceof is unreliable under Vite
  // module duplication). #361 the serial chain is gone (it cost a round-trip per click); the
  // published reload stays COALESCED to the burst's last settle (a per-click reload repainted
  // intermediate committed states against the user's final optimistic flip — the mechanism).
  const pendingTogglesRef = useRef(0);
  const onToggleTask = useCallback(
    (index: number, applyFlip: () => void) => {
      pendingTogglesRef.current += 1;
      const settle = () => {
        pendingTogglesRef.current -= 1;
        if (pendingTogglesRef.current === 0) reloadPublished();
      };
      applyFlip(); // #361 no serial chain — the draft flip and the POST fire on the click frame
      return apiFetch<{ publishedAt: string | null }>(`/pages/${encodeURIComponent(pageId)}/tasks/toggle`, token, {
        method: "POST",
        body: JSON.stringify({ index }),
      }).then(() => { settle(); }).catch((e) => {
        settle();
        const err = e as { status?: number; code?: string } | null;
        if (err?.status === 409 && err.code === "task_burst") return undefined; // transient — never undo the user's flip
        const dirty = err?.status === 409;
        notify.error(t(dirty ? "toast.taskToggleDirty" : "toast.actionFailed"));
        throw e; // let the editor revert the optimistic flip
      });
    },
    [pageId, token, reloadPublished, t],
  );

  // #448: STABLE (useCallback) so the Editor's mount-captured vim-ex wiring (:w/:wq) can hold it
  // the server publish route is ALREADY guest:'edit' (#328/ADR-140: FGA edit gate + guest rate cap +
  // abuse filter + anonId attribution); only this client wiring was missing.
  const onPublish = useCallback(async () => {
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
  }, [pageId, token, t, reloadPublished]);
  // #448: vim :w/:wq/:q parity with the member surface — publish must be fire-and-forget for the
  // Editor's => void contract; :q exits edit mode without publishing.
  const publishForEditor = useCallback(() => { void onPublish(); }, [onPublish]);
  const exitEdit = useCallback(() => setEditing(false), []);

  const controls: PageControlsProps = {
    canEdit,
    editing,
    onEdit: () => setEditing(true),
    onDone: () => setEditing(false),
    vim: effectiveVim,
    vimForcedOff, // #512: coarse pointer OR WYSIWYG
    onToggleVim: toggleVim,
    displayMode,
    onCycleDisplayMode: cycleDisplayMode,
    onSetDisplayMode: setDisplayMode,
    canPublish: true,
    onPublish: canEdit ? publishForEditor : undefined,
    publishing,
    // #100: comments toggle — shown to any guest who can VIEW (reading is guest:'view'); the composer
    // inside the panel is gated on canComment (comment_open). openComments count is member-only chrome.
    commentsOpen,
    onToggleComments: () => setCommentsOpen((o) => !o),
    tocOpen: tocOn,
    onToggleToc: () => setTocOn(!tocOn),
  };
  return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        {onBack && (
          <button type="button" onClick={onBack} data-testid="guest-space-back" style={{ alignSelf: "flex-start", margin: "8px 12px 0", padding: "4px 8px", background: "transparent", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer" }}>
            ← {t("share.backToSpace")}
          </button>
        )}
        <div className="relative flex min-h-0" style={{ flex: 1 }}>
          <div className="relative min-w-0 flex-1">
            {/* #318: the guest surface gets the SAME frosted title band as the member page (#212) / public
                reader (#227). #274 supersedes the #318 "no rename for guests" rule for the EDIT
                capability: guests can now CREATE pages (named "Untitled"), so naming must happen here like
                it does for members — PATCH /pages/:id is guest:'edit' opt-in with the FGA edit gate (the
                same trust level as body editing). VIEW links keep the read-only h1 (no affordance). The
                band height is published as --wks-band-h (bandRef) so the editor's first line clears it. */}
            <div ref={bandRef} className="pointer-events-none absolute inset-x-0 top-0 z-20 pb-6">
              <div aria-hidden="true" className="absolute inset-y-0 left-0 right-2.5 bg-gradient-to-b from-[color-mix(in_srgb,var(--bg)_90%,transparent)] via-[color-mix(in_srgb,var(--bg)_42%,transparent)] to-transparent backdrop-blur-md [mask-image:linear-gradient(to_bottom,black_50%,transparent)]" />
              <div className="pointer-events-auto relative mx-auto flex w-full max-w-[740px] items-center gap-3 px-6 pt-6">
                <div className="min-w-0 flex-1" data-testid="guest-title-band">
                  {/* a home page is named by its space, so renaming it here would be renaming the wrong
                      thing — the member surface hides the rename on home for the same reason */}
                  <PageTitle
                    title={isHome ? t("spaceHome.title", { name: pageTitle }) : pageTitle}
                    onRename={canEdit && !isHome ? renameGuestPage : undefined} />
                </div>
                {/* Desktop: the status chip rides the band row (member parity); mobile keeps the ⋯ controls. */}
                {/* #406 PageStatus stays at every width. It carries the TOC toggle AND the
                    draft / unpublished badges, so gating it on isDesktop hid the publish state of a
                    page from anyone on a phone — while the public reader showed the same control
                    unconditionally, making the member view the odd one out. */}
                <div className="shrink-0"><PageStatus {...controls} /></div>
              </div>
            </div>
            {/* #374 / ADR-149 §1: pass pageId so the guest resolvers (server diagram render, transclude) build
                their URL and fetch with the SHARE TOKEN — the /pages/:id/plantuml/render + /attachments routes are
                already `guest: 'view'` gated, so no new authz surface; it just lights up the macros the member
                surface renders. mermaid is pure-client and needs no token.
                #374 guestSurface keeps the MEMBER-ONLY sources (title dictionary / backlinks / query)
                suppressed — pageId used to double as their gate, so passing it above un-gated them on this
                guest surface (the title-links-224 guest anti-test: no auto links for a guest, 2-layer rule). */}
            {/* #457 the guest body gets the SAME loading/empty distinction as the member surface
                the identical opaque inset-0 overlay (the lesson: it must fully cover the mounted
                Editor so the skeleton and real content never show together). The Editor stays mounted
                underneath (collab/presence invariant), exactly like the member wiring above. */}
            <BodyPlaceholder
              loading={!publishedLoaded && !editing}
              empty={publishedLoaded && !editing && !(publishedMd ?? "").trim()}
              canEdit={canEdit}
            />
            <Editor key={docName} docName={docName} pageId={pageId} guestSurface token={token} collabUrl={COLLAB_URL} user={guest} capability={capability} apiToken={token} publishedMd={publishedMd} editing={editing} vim={effectiveVim} displayMode={displayMode} onHeadings={onHeadings} onActiveHeading={onActiveHeading} onVisibleHeadings={onVisibleHeadings} onScrollActivity={onScrollActivity} tocJumpRef={tocJumpRef} onExitEdit={exitEdit} onPublish={canEdit ? publishForEditor : undefined} onToggleTask={canEdit ? onToggleTask : undefined} />
            {isDesktop ? (<><PageVim {...controls} /><PageActions {...controls} /></>) : <PageControlsMobile {...controls} />}
            {/* #227 the shared TocChrome (rail on wide / overlay on narrow); yields to the comments
                panel when open (shared right zone — no pointer overlap). */}
            <TocChrome
              headings={headings}
              activeFrom={activeHeading}
              visibleFroms={visibleHeadings}
              depth={tocDepth}
              onJump={(f) => { tocJumpRef.current?.(f); const h = headings.find((x) => x.from === f); if (h) replaceHashWith(h.slug); }}
              subscribeScroll={subscribeTocScroll}
              isWide={isWide}
              tocOn={tocOn}
              railEnabled={!commentsOpen}
              // #274 (1): band-aware like the member shell — the hardcoded 0.5rem ignored
              // --wks-band-h (set by this shell's bandRef) and slid the rail under the title band.
              railTop="calc(var(--wks-band-h, 0px) + 0.5rem)"
            />
          </div>
          {commentsOpen && <CommentsPanel pageId={pageId} canComment={canComment} anchorGetterRef={anchorGetterRef} onClose={() => setCommentsOpen(false)} token={token} />}
        </div>
      </div>
  );
}

// Page-link guest route: a single page, NO space tree (a page-scoped link grants no authority to traverse
// the space — #245 / ADR-112 Decision 3). Chrome-less AppShell wrapping the page content.
function GuestPage({ minted }: { minted: GuestToken }) {
  return <AppShell><GuestPageContent minted={minted} /></AppShell>;
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

// #227 / ADR-030: the PUBLIC page view — the missing consumer of GET /public/pages/:id. Renders a
// published-public page for ANONYMOUS visitors (no session; this route never touches useSession, so
// unauthenticated visits don't bounce to the login screen) plus its PUBLIC child tree as nested nav
// links (the server authorizes each child individually with the anonymous principal — a non-public
// child and its whole subtree are absent from the payload, so nothing here can leak).
// XSS: the body is rendered through the SAME shared allowlist-by-construction renderer the editor
// uses (renderMarkdownToDom — raw HTML degrades to escaped text, hrefs are scheme-checked); the API
// 404s for anything non-public (existence hidden), which renders as the not-found screen.
interface PublicChildNode { id: string; title: string; children: PublicChildNode[] }
// (#227 ②: the old PublicTree bottom-nav for /pub/:id was removed — a standalone public page
// shows ONLY its page; space-level publish provides the tree via the sidebar shell.)

// The rendered body of a single public page (no chrome). Reused by PublicPageRoute and PublicSpaceRoute
// (#227). ②: a standalone /pub/:id shows ONLY its page (the old bottom child-tree nav is gone
// page-level publish = just the page; SPACE-level publish is the sidebar shell with the tree).
// #430 the space a public page belongs to — name + (optional) icon, both served publicly.
export interface PublicSpaceContext { name: string; iconImageUrl: string | null }

function PublicPageContent({ pageId, onSpace }: { pageId: string; onSpace?: (s: PublicSpaceContext | null) => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ status: "loading" | "notfound" | "ok"; page?: { id: string; title: string; content: string; noindex: boolean; children: PublicChildNode[]; space?: PublicSpaceContext } }>({ status: "loading" });
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null); // callback ref → reactive for the TOC hook
  const [outerEl, setOuterEl] = useState<HTMLDivElement | null>(null); // #227 non-scrolling positioning context
  const [bandEl, setBandEl] = useState<HTMLDivElement | null>(null); // #227 ②: publish the band's real height
  const isWide = useMediaQuery("(min-width: 1200px)");
  const { on: tocOn, setOn: setTocOn } = useTocPref(); // #227 ①: TOC on/off parity with the member view
  // #319 / ADR-124: the public body renders with the member CM6 read engine (mountPublishedView), so its TOC
  // is driven by the CM heading extension via wireToc — the member page-route wiring (headings state + a jump
  // ref + a scroll-activity fan-out), not the old DOM-scraping usePublicToc (CM headings are not <h1> tags).
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeFrom, setActiveFrom] = useState<number | null>(null);
  const [visibleFroms, setVisibleFroms] = useState<number[]>([]); // #345 light-layer set
  const tocJumpRef = useRef<((from: number) => void) | null>(null);
  const tocJump = useCallback((f: number) => tocJumpRef.current?.(f), []);
  useHeadingHashLanding(headings, tocJump); // #313: /pub/:id#<slug> deep link → band-aware CM jump
  const tocScrollListeners = useRef(new Set<() => void>());
  const subscribeTocScroll = useCallback((fn: () => void) => { tocScrollListeners.current.add(fn); return () => { tocScrollListeners.current.delete(fn); }; }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetch(assetUrl(`/public/pages/${encodeURIComponent(pageId)}`))
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setState({ status: "notfound" }); return; }
        const payload = await res.json();
        setState({ status: "ok", page: payload });
        onSpace?.(payload?.space ?? null); // hoist the space context into the header slot
      })
      .catch(() => { if (!cancelled) setState({ status: "notfound" }); });
    return () => { cancelled = true; };
  }, [pageId]);

  // #319 / ADR-124: render the public body with mountPublishedView (the member read engine) instead of the
  // reduced renderMarkdownToDom, so math / code highlighting / task checkboxes / line wrapping / every macro
  // render structurally identical to the real page. The anonymous-context XSS boundary was re-proven
  // (review, ADR-124 — the one finding, an unsanitized :::embed-external degrade href, is
  // fixed). The CM6 engine is LAZY-loaded (dynamic import) — a hygiene split (routes.tsx already pulls CM6 via
  // the member Editor, so eager growth is ~net-zero; the fuller isolation is a later member-route lazify).
  // #376 / ADR-149 §2: the PUBLIC resolvers are wired (images / plantuml / transclusions render for anon
  // readers via the ANON-gated, abuse-bounded /public/* routes; refusals degrade like before). theme is an
  // effect dep so a light/dark switch remounts the surface — mermaid/plantuml re-render for the new theme
  // (#342/#360 class; the widget theme is read at render time). wireToc drives the TOC from the CM heading
  // extension, listening on the OUTER scroll container.
  const { theme: publicTheme } = useTheme();
  useEffect(() => {
    if (state.status !== "ok" || !bodyEl) return;
    setHeadings([]);
    setActiveFrom(null);
    setVisibleFroms([]);
    let cancelled = false;
    let dispose = () => {};
    void Promise.all([import("../editor/editor-livepreview"), import("../editor/toc-wiring"), import("../editor/resolver-set")]).then(([{ mountPublishedView }, { wireToc }, { makeResolverSet }]) => {
      if (cancelled || !bodyEl) return;
      // #381 / ADR-163: the "public" context is exactly the ADR-149 anonymous trio (tokenless) — the
      // facade owns that closure, so this surface can never mount with empty resolvers again (#376).
      const view = mountPublishedView(bodyEl, state.page!.content, makeResolverSet({ kind: "public", pageId }));
      const unwire = wireToc(view, {
        onHeadings: setHeadings,
        onActiveHeading: setActiveFrom,
        onVisibleHeadings: setVisibleFroms,
        onScrollActivity: () => tocScrollListeners.current.forEach((fn) => fn()),
        tocJumpRef,
        // The CM view owns the scrolling (band is an absolute overlay, content clears it via
        // `.lp-editor-host .cm-content { padding-top: var(--wks-band-h) }`), exactly like the member view
        // so wireToc uses its defaults (the CM scroller + contentDOM padding-top as the band offset).
      });
      dispose = () => { unwire(); view.destroy(); };
    });
    return () => { cancelled = true; dispose(); if (bodyEl) bodyEl.replaceChildren(); };
  }, [state, bodyEl, pageId, publicTheme]);

  useEffect(() => {
    if (state.status !== "ok" || !state.page!.noindex) return;
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, [state]);

  // #319: hover 🔗 heading anchors are now provided by the CM `headingAnchors` extension inside
  // mountPublishedView (member parity) — the old DOM-based addHeadingAnchorButtons + usePublicToc are gone.

  // #227 ②: publish the frosted band's ACTUAL height as --wks-band-h on the outer wrapper (a 2-line
  // title makes the band taller, so a fixed value can't clear it). Mirrors the member bandRef ResizeObserver.
  // The body headings read it via scroll-margin-top (public.css) so a TOC jump lands BELOW the band, and the
  // rail's top offset clears it. Set on the outer (non-scrolling) element so it inherits down to the headings.
  useEffect(() => {
    if (!outerEl || !bandEl) return;
    const publish = () => outerEl.style.setProperty("--wks-band-h", `${bandEl.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(bandEl);
    return () => ro.disconnect();
  }, [outerEl, bandEl, state]);

  // #364 ②: the public reader's loading was a bare empty div = a white page while resolving.
  if (state.status === "loading") return <ShellLoading />;
  if (state.status === "notfound") {
    return <div data-testid="public-not-found" style={{ padding: 24, fontFamily: "var(--font-body, sans-serif)" }}>{t("publicPage.notFound")}</div>;
  }
  const page = state.page!;
  return (
    // #227 ①: the OUTER wrapper is the non-scrolling positioning context (like the member editor area,
    // routes.tsx ~450). The scroller is the INNER div — so the TOC rail, positioned absolutely on THIS outer
    // wrapper, stays viewport-fixed instead of scrolling away with the content. h-full is bounded by the
    // parent in both layouts (AppShell main on the space route; the route container on /pub/:id).
    <div ref={setOuterEl} className="wks-public relative h-full" style={{ fontFamily: "var(--font-body, sans-serif)" }}>
      {/* #319: mirror the member editor-area layout (routes.tsx ~511) so the embedded CM read view OWNS the
          scrolling (its `.cm-scroller` virtualizes) instead of an outer scroller. The band is an ABSOLUTE
          overlay over the top of the CM surface; content scrolls UNDER it and clears it via
          `.lp-editor-host .cm-content { padding-top: var(--wks-band-h) }`. */}
      <div className="relative h-full" style={{ minHeight: 0 }}>
        {/* #227 ① : the member frosted title BAND, reused read-only. An absolute overlay (pointer-events-none;
            its row is auto) so the CM content scrolls under it and the frost actually shows. PageTitle with no
            onRename renders a plain read-only <h1>. The band's height is published as --wks-band-h (bandEl RO)
            so the CM content padding + rail offsets clear it. ①/ ④: the MEMBER band row (740px
            column) with the member `PageStatus` TOC toggle. */}
        <div ref={setBandEl} data-testid="public-band" className="pointer-events-none absolute inset-x-0 top-0 z-20 pb-6">
          <div aria-hidden="true" className="absolute inset-x-0 inset-y-0 bg-gradient-to-b from-[color-mix(in_srgb,var(--bg)_90%,transparent)] via-[color-mix(in_srgb,var(--bg)_42%,transparent)] to-transparent backdrop-blur-md [mask-image:linear-gradient(to_bottom,black_55%,transparent)]" />
          <div className="pointer-events-auto relative mx-auto flex w-full max-w-[740px] items-center gap-3 px-6 pt-6" data-testid="public-title">
            <div className="min-w-0 flex-1">
              <PageTitle title={page.title} />
            </div>
            {/* read-only viewer: only the TOC toggle renders (no publish state, no edit affordances). */}
            <div className="shrink-0">
              <PageStatus canEdit={false} editing={false} onEdit={() => {}} onDone={() => {}} tocOpen={tocOn} onToggleToc={() => setTocOn(!tocOn)} />
            </div>
          </div>
        </div>
        {/* the CM read view fills this box and scrolls internally (the member surface pattern). */}
        {/* #319 c1587-A: `data-pane="preview"` gives the public body the SAME 740px centred reading column as
            the member Reading surface (tokens.css). The band top-offset (`.lp-editor-host .cm-content`
            padding-top) has higher specificity, so it still wins over this rule's padding-top. */}
        <div ref={setBodyEl} data-testid="public-body" data-pane="preview" className="h-full" />
      </div>
      {/* #227 the SAME shared TocChrome the member views render (rail on wide / overlay on narrow) — no
          public-only reimplementation. The toggle lives in the band's PageStatus (member parity, ①).
          The rail offsets clear the frosted band (--wks-band-h, published above by the bandEl RO). */}
      <TocChrome
        headings={headings}
        activeFrom={activeFrom}
        visibleFroms={visibleFroms}
        depth={3}
        onJump={(f) => { tocJump(f); const h = headings.find((x) => x.from === f); if (h) replaceHashWith(h.slug); }}
        subscribeScroll={subscribeTocScroll}
        isWide={isWide}
        tocOn={tocOn}
        railLeft="calc(50% + 368px)"
        railTop="calc(var(--wks-band-h, 5.5rem) + 2.75rem)"
      />
    </div>
  );
}

// #430: the public reader's MINIMAL header — tenant brand (logo/name), the SPACE this content belongs
// to (icon + name), the #429 theme + language toggles, and — on the FREE plan only — a subtle "Powered
// by Wikistead" (the owner's freemium ruling; paid tenants white-label via the ONE /branding
// entitlement seam). NEVER any member chrome here.
// the space identity is shown on EVERY plan, white-label included. White-labelling suppresses
// WIKISTEAD's branding; the tenant's own space name and icon are the tenant's content, so hiding them
// served nobody — on a self-host tenant (white-label by default, no custom logo) it left the header's
// entire left side blank.
function PublicHeader({ space }: { space?: PublicSpaceContext | null }) {
  const { t } = useTranslation();
  const branding = useBranding();
  const b = branding.data;
  return (
    <header className="flex h-10 flex-none items-center gap-2 border-b border-border bg-panel px-4" data-testid="public-header">
      {/* #143 two-slot rule, via the ONE shared lockup (#442 TenantBrand): the icon slot is a custom
          logo OR the default mark, the name slot is the tenant name OR "Wikistead", and the two are
          INDEPENDENT — setting one never blanks the other. The public header had grown its own copy
          of this composition where a custom name suppressed the mark and a custom logo
          suppressed the name — exactly the drift #442 folded member + sign-in into TenantBrand to
          stop. White-labelling still REPLACES the Wikistead brand rather than erasing it: an
          unset slot shows the Wikistead default, which is what TenantBrand does. "Powered by
          Wikistead" is a free plan's attribution, not an identity, so it stays on the entitlement
          below. testids kept (public-brand-logo / public-brand) so the existing pins still resolve. */}
      <TenantBrand logoUrl={b?.logoUrl} name={b?.displayName} logoTestId="public-brand-logo" nameTestId="public-brand" />
      {space && (
        <span className="flex min-w-0 items-center gap-1.5" data-testid="public-space-context">
          {space.iconImageUrl ? (
            <img className="h-[18px] w-[18px] flex-none rounded object-cover" src={assetUrl(space.iconImageUrl)} alt="" data-testid="public-space-icon" />
          ) : (
            // no uploaded icon → the same deterministic initials chip the member sidebar uses, so the
            // slot is never empty and the space still reads as itself
            <Avatar name={space.name} seed={space.name} size={18} data-testid="public-space-icon" />
          )}
          <span className="min-w-0 truncate text-[13px] font-medium">{space.name}</span>
        </span>
      )}
      <div className="flex-1" />
      {b && !b.whitelabel && (
        <span className="text-[11px] text-fg-dim opacity-70" data-testid="powered-by">{t("publicReader.poweredBy")}</span>
      )}
      {/* #429 ruling: theme AND language ride the minimal public header (JA is core to positioning
          one click away for anonymous readers too; the space reader gets both via the AppShell header) */}
      <LanguageToggle />
      <ThemeToggle />
    </header>
  );
}

function PublicPageRoute() {
  const { pageId } = useParams<{ pageId: string }>();
  // #430 the standalone reader used to render PublicHeader with NO arguments, so its space slot
  // was permanently empty — and on a white-label tenant (self-host default) the brand mark and name are
  // both suppressed, leaving the whole left side blank. The page load now reports its space, which the
  // header always shows.
  const [space, setSpace] = useState<PublicSpaceContext | null>(null);
  if (!pageId) return <div data-testid="public-not-found" style={{ padding: 24 }} />;
  return (
    <div className="flex h-dvh flex-col">
      <PublicHeader space={space} />
      <div className="relative min-h-0 flex-1">
        <PublicPageContent pageId={pageId} onSpace={setSpace} />
      </div>
    </div>
  );
}

// #227 / ADR-030 (comment 966, option b): the anonymous read-only PUBLIC reader-chrome for a public space.
// Reuses the app shell with a READ-ONLY sidebar (the space's published+public page tree) — the anonymous
// visitor browses a public space exactly like a member, but every fetch is a PUBLIC endpoint
// /public/spaces/:id/pages + /public/pages/:id), member routes are never touched (no session → no login
// bounce), and there is NO member chrome (search / user menu / edit / create). A non-public space → 404.
// #227 map the public tree (`/public/spaces/:id/pages` — every node is published + public) onto the
// shared PageTreeNode shape. Published/non-private/ring-less, so the draft/unpublished/private/ring badges all
// collapse. This is the ONLY public-specific code left; the rendering is the member PageTree component itself.
function toPublicTreeNodes(nodes: PublicChildNode[]): PageTreeNode[] {
  return nodes.map((n) => ({
    id: `page:${n.id}`, name: n.title, pageId: n.id, spaceId: "",
    published: true, unpublished: false, private: false, taskDone: 0, taskTotal: 0,
    children: toPublicTreeNodes(n.children),
  }));
}
function PublicSpaceSidebar({ nodes, home, openId, onOpen }: { nodes: PublicChildNode[]; home: { id: string; title: string } | null; openId: string | null; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const treeNodes = useMemo(() => toPublicTreeNodes(nodes), [nodes]);
  // The SAME frame + tree component the member Sidebar renders (data-testid="sidebar" + PageTree rows), but
  // read-only: no canEdit → no row menu / DnD / create; no session — every node came from a /public/* fetch.
  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden text-[length:var(--text-ui)]" data-testid="sidebar">
      {/* #430 (ruling c, #270 parity): the space NAME as context atop the public tree — home.title IS the
          bare space name under the #364 plan-A storage rule; absent home → no heading (nothing to leak). */}
      {home && (
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 font-semibold text-foreground" data-testid="public-space-heading">
          <span className="truncate">{home.title}</span>
        </div>
      )}
      {/* #364 / ADR-157: the public space's HOME — a fixed entry above the tree (the tree excludes it). */}
      {home && (
        <div className="border-b border-border px-1 py-1">
          <div
            className={`flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 transition-colors duration-[120ms] ${openId === home.id ? "bg-[color-mix(in_srgb,var(--accent)_12%,var(--panel-3))] font-medium" : "hover:bg-panel-2"}`}
            data-testid="public-home-entry"
            onClick={() => onOpen(home.id)}
          >
            <Home size={14} className="flex-none text-fg-dim" />
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{t("sidebar.home")}</span>
          </div>
        </div>
      )}
      <PageTree nodes={treeNodes} selectedId={openId} onOpen={onOpen} openByDefault />
    </div>
  );
}
// #430: the free-plan "Powered by Wikistead" marker for the public SPACE reader's AppShell header
// (the standalone page header renders its own copy inside PublicHeader). Paid/white-label → nothing.
function PublicPoweredBy() {
  const { t } = useTranslation();
  const branding = useBranding();
  const b = branding.data;
  if (!b || b.whitelabel) return null;
  return <span className="text-[11px] text-fg-dim opacity-70" data-testid="powered-by">{t("publicReader.poweredBy")}</span>;
}

function PublicSpaceRoute() {
  const { t } = useTranslation();
  const { spaceId } = useParams<{ spaceId: string }>();
  const [tree, setTree] = useState<PublicChildNode[] | null>(null);
  const [home, setHome] = useState<{ id: string; title: string } | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!spaceId) { setNotFound(true); return; }
    fetch(assetUrl(`/public/spaces/${encodeURIComponent(spaceId)}/pages`))
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setNotFound(true); return; }
        // #364 / ADR-157: the route now returns { home, tree }; tolerate the legacy bare array.
        const body = (await res.json()) as PublicChildNode[] | { home: { id: string; title: string } | null; tree: PublicChildNode[] };
        const t = Array.isArray(body) ? body : body.tree;
        const h = Array.isArray(body) ? null : body.home;
        setTree(t);
        setHome(h);
        setOpenId(h?.id ?? t[0]?.id ?? null); // the home is the space root — open it by default
      })
      .catch(() => { if (!cancelled) setNotFound(true); });
    return () => { cancelled = true; };
  }, [spaceId]);

  if (notFound) return <AppShell><div data-testid="public-not-found" style={{ padding: 24 }}>{t("publicPage.notFound")}</div></AppShell>;
  return (
    <AppShell sidebar={<PublicSpaceSidebar nodes={tree ?? []} home={home} openId={openId} onOpen={setOpenId} />} headerExtra={<PublicPoweredBy />}>
      {openId ? (
        <PublicPageContent key={openId} pageId={openId} />
      ) : (
        <div className="flex h-full items-center justify-center p-8 text-fg-dim" data-testid="public-space-empty">
          {tree == null ? "" : t("share.spacePickPrompt")}
        </div>
      )}
    </AppShell>
  );
}

// #364 / ADR-157 §5-§6: the space ROOT route — the member landing for a space. Renders the HOME page
// with the FULL page machinery (PageRoute with an override id), or the empty state: the space-name
// heading + a "write the homepage" button visible ONLY to edit-capable viewers (owner ruling 3).
function SpaceHomeRoute() {
  const { t } = useTranslation();
  const { spaceId } = useParams<{ spaceId: string }>();
  const { status, logout, token } = useSession();
  const spacesQ = useSpaces(status === "authed");
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const { setActiveSpaceId } = useActiveSpace();
  const space = (spacesQ.data ?? []).find((sp) => sp.id === spaceId);
  // #364 ①: the sidebar follows the URL here, not an opened page. The page-driven sync (PageRoute)
  // never fires for a home-less space (the empty state opens no page), so a direct /spaces/:id link left
  // the sidebar on the previous space. Sync from the RESOLVED space (not the raw param) so a bogus id
  // (the not-found branch) can't hijack the sidebar.
  useEffect(() => { if (space?.id) setActiveSpaceId(space.id); }, [space?.id, setActiveSpaceId]);
  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  if (spacesQ.isSuccess && !space) {
    return (
      <AppShell sidebar={<Sidebar />} search={<SearchBox />} onLogout={logout}>
        <div style={{ padding: 24 }} data-testid="page-not-found">{t("page.notFound")}</div>
      </AppShell>
    );
  }
  // #364 hand the RESOLVED space name down. The band must never interpolate `page.title`
  // (a pre-ruling home carries the baked suffix → doubled label), and reading it from a second
  // useSpaces inside PageRoute would render an empty name on the first frame; this route already
  // has the space in hand, so the label is correct on the FIRST paint.
  if (space?.homePageId) return <PageRoute pageIdOverride={space.homePageId} homeSpaceName={space.name} />;
  const canEdit = space?.capability === "edit" || space?.capability === "manage";
  const createHome = () => {
    if (!spaceId || creating) return;
    setCreating(true);
    void apiFetch<{ id: string }>(`/spaces/${encodeURIComponent(spaceId)}/home`, token, { method: "POST" })
      .then(async (r) => {
        await qc.invalidateQueries({ queryKey: ["spaces"] });
        // land in the editor immediately — the new home is an unpublished draft only the creator sees
        if (r?.id) navigate(`/spaces/${spaceId}?edit=1`, { replace: true });
      })
      .catch(() => notify.error(t("toast.actionFailed")))
      .finally(() => setCreating(false));
  };
  return (
    <AppShell sidebar={<Sidebar />} search={<SearchBox />} onLogout={logout}>
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8" data-testid="space-home-empty">
        <h1 className="text-2xl font-semibold">{space ? t("spaceHome.title", { name: space.name }) : ""}</h1>
        {canEdit && (
          <Button variant="primary" data-testid="space-home-create" disabled={creating} onClick={createHome}>
            {t("spaceHome.writeButton")}
          </Button>
        )}
      </div>
    </AppShell>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/p/:pageId" element={<PageRoute />} />
      <Route path="/spaces/:spaceId" element={<SpaceHomeRoute />} /> {/* #364 / ADR-157 §6: the space root */}
      <Route path="/pub/space/:spaceId" element={<PublicSpaceRoute />} />
      <Route path="/pub/:pageId" element={<PublicPageRoute />} />
      <Route path="/share/:linkId" element={<ShareRoute />} />
      <Route path="/invite" element={<InviteRoute />} />
      <Route path="/templates" element={<TemplatesRoute />} />
      <Route path="/changes" element={<RecentChangesRoute />} />
      <Route path="/watches" element={<WatchListRoute />} /> {/* #362 the bell's watch list */}
      <Route path="/admin/*" element={<Suspense fallback={<LazyFallback />}><AdminRoot /></Suspense>} />
      <Route path="/settings/account/*" element={<Suspense fallback={<LazyFallback />}><AccountRoot /></Suspense>} />
      <Route path="/spaces/:spaceId/settings/*" element={<Suspense fallback={<LazyFallback />}><SpaceSettingsRoot /></Suspense>} />
      {/* Back-compat: the old members URL now lives under the admin console. */}
      <Route path="/settings/members" element={<Navigate to="/admin/members" replace />} />
      <Route path="/join" element={<JoinRoute />} />
      <Route path="/join/workspace" element={<WorkspaceRoute />} />
      {/* #261: the auth callback redirects failures to /login?error=<kind>. A dedicated route renders the
          sign-in screen so the error query survives (the catch-all below would rewrite it to /p/demo and
          drop it). */}
      <Route path="/login" element={<LoginScreen />} />
      {/* Dev default: the seeded demo page. Real landing/space routing is a
          next-stage screen. */}
      <Route path="*" element={<Navigate to="/p/demo" replace />} />
    </Routes>
  );
}
