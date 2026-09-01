import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { refreshVimMono, reflectEditing } from "./FontProvider"; // #633: vim decides the prose grid, while editing
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes, useParams, useSearchParams, useNavigate, Link as RouterLink } from "react-router-dom";

// #489: route-based code splitting. The admin console, account settings, space settings and the login
// screen are OFF the initial editor path, so they load from their own chunks behind a Suspense
// boundary instead of riding the eager main bundle. Behaviour is unchanged — same paths, same
// components; only the load moment moves (a brief fallback on first navigation to each subtree).
const AdminRoot = lazy(() => import("../settings/AdminPage").then((m) => ({ default: m.AdminRoot })));
const AccountRoot = lazy(() => import("../settings/AccountPage").then((m) => ({ default: m.AccountRoot })));
const SpaceSettingsRoot = lazy(() => import("../settings/SpaceSettingsPage").then((m) => ({ default: m.SpaceSettingsRoot })));
// #489 (route-split, cont.): the templates gallery, the recent-changes feed and the watch-management
// list are their own routes OFF the editor path — split them out of the eager main bundle too, behind
// the same Suspense boundary. Same paths/components; only the load moment moves to first navigation.
const TemplatesRoute = lazy(() => import("./TemplatesPage").then((m) => ({ default: m.TemplatesRoute })));
const RecentChangesRoute = lazy(() => import("./RecentChangesPage").then((m) => ({ default: m.RecentChangesRoute })));
const WatchListRoute = lazy(() => import("../notifications/WatchListPage").then((m) => ({ default: m.WatchListRoute })));
// #489 (route-split, cont.): the on-demand right-panels are only mounted when the reader OPENS them
// ({flag && <Panel/>}), yet they rode the eager main bundle. Split each behind its own chunk; a null
// fallback is fine (the chunk loads in well under a frame, and the panel is a deliberate open action).
const CommentsPanel = lazy(() => import("../comments/CommentsPanel").then((m) => ({ default: m.CommentsPanel })));
const AnalyticsRightPanel = lazy(() => import("./AnalyticsRightPanel").then((m) => ({ default: m.AnalyticsRightPanel }))); // #464
const HistoryPanel = lazy(() => import("../history/HistoryPanel").then((m) => ({ default: m.HistoryPanel })));
const DiffModal = lazy(() => import("../history/DiffModal").then((m) => ({ default: m.DiffModal })));
const AttachmentsPanel = lazy(() => import("../attachments/AttachmentsPanel").then((m) => ({ default: m.AttachmentsPanel })));
const RelatedPanel = lazy(() => import("./RelatedPanel").then((m) => ({ default: m.RelatedPanel })));
// A minimal, chrome-free fallback for a lazy subtree (the chunk loads in well under a frame on a warm
// cache; this only shows on the very first navigation to that area).
function LazyFallback() {
  const { t } = useTranslation();
  return <div style={{ padding: 24, color: "var(--fg-dim)" }}>{t("common.loading")}</div>;
}
import { HomeEmpty } from "./HomeEmpty";
import { AppShell } from "./AppShell";
import { LoginScreen, RecoveryScreen } from "./LoginScreen";
import { SetPasswordForm } from "./SetPasswordForm";




import { Editor, type AnchorGetter } from "../editor/Editor";
import { useNotLiveToast, toastReason } from "../editor/useNotLiveToast";
import type { Liveness } from "../editor/collab";
import { makeGuestSession, type GuestSession } from "../session/guest-session";
import { isServerFault, isServerFaultError, HttpStatusError, loadVerdict } from "./serverFault"; // #886 / #681: one place decides "the server failed"
import { setVimClipboardMode } from "../editor/live-preview/vim-clipboard";
import { createDirtySignal } from "../editor/dirtySignal";
import { createUnsyncedSignal, useUnsynced } from "../editor/unsyncedSignal";
import { colorFromString } from "../ui/avatar";

// Persisted vim-keymap preference for the single edit surface (Step I). Replaces the
// old single/split layout preference; vim is now a keymap toggle on the one surface.
const KEYMAP_LS = "wks.editorVim";
const readLocalVim = () => { try { return localStorage.getItem(KEYMAP_LS) === "1"; } catch { return false; } };
const writeLocalVim = (on: boolean) => { try { localStorage.setItem(KEYMAP_LS, on ? "1" : "0"); } catch { /* no storage */ } };

// #633 / ADR-217: vim's typography is "vim is on AND the reader kept the toggle". The two inputs live
// in different places (the keymap here, the toggle in FontProvider), so they meet on <html>: this marks
// that vim is on, and `applyVimMono` adds the marker tokens.css actually reads. Both hooks below call
// it, because a guest and a member both have vim and both deserve the same typography.
function reflectVim(on: boolean): void {
  const root = document.documentElement;
  if (on) root.setAttribute("data-vim-on", "");
  else root.removeAttribute("data-vim-on");
  refreshVimMono();
}

// Guest editor keymap (share-link, no member row): localStorage only — there is no
// server profile to sync to.
function useVimPref(): [boolean, () => void] {
  const [vim, setVim] = useState(readLocalVim);
  const toggle = useCallback(() => setVim((v) => { writeLocalVim(!v); return !v; }), []);
  useEffect(() => { reflectVim(vim); return () => reflectVim(false); }, [vim]);
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
  // ADR-105 / #225: the vim⇄clipboard mode is a MODULE REF read at keystroke time (never a vim
  // Compartment reconfigure — the toggle-keeps-collab invariant). Guests have no member row and
  // never load account settings, so the ref keeps its 'off' default (pure vim) for them.
  const clipMode = settings.data?.editorVimClipboard;
  useEffect(() => { setVimClipboardMode(clipMode ?? "off"); }, [clipMode]);
  useEffect(() => {
    if (!mode) return;
    if (mode === "vim") setVim(true);
    else if (mode === "default") setVim(false);
    else setVim(readLocalVim()); // 'local'
  }, [mode]);
  useEffect(() => { reflectVim(vim); return () => reflectVim(false); }, [vim]);
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
import { PrintSurface } from "./PrintSurface"; // #505 the print-only static (paginating) surface
import { downloadBrowserExport, printBrowserExport } from "../data/exportBrowser"; // #85 / ADR-194 Option B
import { makeDiagramRenderer } from "../editor/diagram-renderer"; // #505: the export asks the host for plantuml
// #85: the export asks the host for an EMBED too — the same resolver and the same denied wording
// the editing surface uses, so the file and the screen answer from one place.
import { makeTranscludeResolver } from "../editor/transclude-resolver";
import { deniedEmbedLabel } from "../editor/macros/placeholder";
import { currentMacroTheme } from "../editor/macros/theme";

// The editor re-reports these on every document change, which is every keystroke. Setting state with a
// fresh array each time re-renders the route, and the route hands <Editor> inline callbacks — so its memo
// misses and the editor re-renders too, breaking the isolation invariant (ADR-013: content lives in
// Y.Text/CM, not in React). Measured: 19 typed characters produced 38 editor renders. Keep the previous
// value when nothing actually changed; React then skips the update entirely.
const sameHeadings = (a: Heading[], b: Heading[]) =>
  a.length === b.length && a.every((h, i) => h.from === b[i]!.from && h.text === b[i]!.text && h.level === b[i]!.level);
// visibleHeadings deliberately keeps NO guard: measured, adding one broke the narrow overlay TOC's
// two-layer highlight, which depends on that update arriving. It also does not need one — the set changes
// on SCROLL, not on typing, so it is not part of the keystroke path this is about.
import { PageMeta } from "./PageMeta";
import { ProgressRing } from "./ProgressRing"; // #290: title-band page-progress ring
import { useTheme } from "./ThemeProvider"; // #376: public reader remounts on theme switch (diagram re-render)
import { ThemeToggle } from "./ThemeToggle"; // #429/#430: the standalone public reader's header controls
import { LanguageToggle } from "./LanguageToggle";
// RelatedPanel / CommentsPanel / HistoryPanel / DiffModal / AttachmentsPanel are lazy (see the top block).
import { Input } from "../ui/Input";
import { ShareDialog } from "../ui/ShareDialog";
import { TocChrome } from "../toc/TocChrome"; // #227: shared TOC rail/overlay/toggle wiring (member + public)
import { useTocPref } from "../toc/useTocPref";
import type { Heading } from "../editor/headings";
import { PermissionsDialog } from "../ui/PermissionsDialog";
import { LoadFailed } from "../ui/LoadFailed";
import { Button } from "../ui/Button";
import { ProseSkeleton, useDelayedFlag } from "../ui/Skeleton";
import { notify } from "../ui/toast";
import { useComments } from "../data/comments";
import { Sidebar } from "../sidebar/Sidebar";
import { PageTree, type PageTreeNode } from "../sidebar/PageTree"; // #227: reuse the member page tree in the public reader
import { SearchBox } from "../search/SearchBox";
import { useSession } from "../session/SessionProvider";
import { fetchGuestToken, apiFetch, assetUrl, type GuestToken } from "../data/apiClient";
import { FALLBACK_PRODUCT_NAME, useProductName } from "./product-name";
import { usePage, usePublished, usePublish, useRenamePage, useToggleTask, useAccountSettings, useDeletePage, useDirectDeletePage, useCreatePage, useEntitlements, useSpacesPage, useResolvedSpace, useResolvedSpaceState, useBranding, invalidateSpaces, type Page } from "../data/queries";
import { TenantBrand } from "./BrandLockup"; // #430 the public header uses the shared two-slot lockup
import { Avatar } from "../ui/Avatar"; // #430 the public header's space chip (shared primitive)
import { GuestSidebar } from "./GuestSidebar";
import { ConfirmDialog } from "../ui/dialogs";
import { DeleteBacklinkWarning } from "./DeleteBacklinkWarning";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
// TemplatesRoute / RecentChangesRoute / WatchListRoute are lazy-loaded (see the lazy block at the top).
import { guestImageUploader } from "./guest-uploader"; // #914
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
// #364 / ADR-157: `pageIdOverride` lets the space-root route (/spaces/:id) render the HOME page with
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
// reported overlap. It sits below the title band (z-20) so the band stays crisp, and above the editor.
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

// #965: pure so the ref-gate rule is pinned directly (no DOM, no dependence on when a background
// refetch happens to re-fire the effect — the #940 flake this used to be entangled with). `lastAppliedFor`
// is the ref's CURRENT value; the caller writes `appliedFor` back into the ref only when `apply` is true.
export function openSpaceForPageDecision(
  lastAppliedFor: string | undefined,
  pageId: string | undefined,
  openSpaceId: string | undefined,
): { apply: false } | { apply: true; appliedFor: string | undefined; spaceId: string } {
  if (!openSpaceId || lastAppliedFor === pageId) return { apply: false };
  return { apply: true, appliedFor: pageId, spaceId: openSpaceId };
}

function PageRoute({ pageIdOverride, homeSpaceName }: { pageIdOverride?: string; homeSpaceName?: string } = {}) {
  const { t } = useTranslation();
  const params = useParams<{ pageId: string }>();
  const pageId = pageIdOverride ?? params.pageId;
  // #710: "is this page some space's home?" is answered by the page's OWN space, resolved by id —
  // a home page always lives in the space that points at it, so the roster walk this used to scan
  // (and miss, past page one) is unnecessary. Resolution happens below, after pageQ names the space.
  const [searchParams, setSearchParams] = useSearchParams();
  const autoEdit = searchParams.get("edit") === "1"; // set by the create-page flow
  // Diff modal is URL-driven (?diff=<revId>): a shallow deep-link (no route added) that
  // restores the open diff on reload, while keeping the editor mounted underneath so
  // presence/collab are untouched (ADR-019).
  const diffRevId = searchParams.get("diff");
  const openDiff = useCallback((revId: string) => setSearchParams((p) => { p.set("diff", revId); return p; }), [setSearchParams]);
  const closeDiff = useCallback(() => setSearchParams((p) => { p.delete("diff"); return p; }), [setSearchParams]);
  const { status, getCollabToken, tenantId, user, logout, token } = useSession();
  // Capability gates the Edit control (UI only — collab server is the fortress).
  // Defaults to view until resolved, so a page is never editable speculatively. A page
  // that does NOT exist (getPage 404) must never become editable — every page belongs
  // to a space (the page#space premise); a spaceless phantom can be typed into via
  // collab but never published. So we do NOT fall back to edit, and a 404 renders a
  // not-found state (below) rather than an empty editable surface.
  const pageQ = usePage(pageId ?? "");
  const page = pageQ.data;
  const capability = page?.capability ?? "view";
  const pageSpace = useResolvedSpace(!pageIdOverride ? page?.spaceId : null);
  const homeOwner = !pageIdOverride && pageId && pageSpace && pageSpace.homePageId === pageId ? pageSpace : undefined;

  // Draft/publish: view renders the PUBLISHED snapshot; edit-capable users get a
  // Publish control + an "unpublished changes" indicator.
  const publishedQ = usePublished(pageId ?? "");
  const published = publishedQ.data;
  const publish = usePublish(pageId ?? "");
  const renamePage = useRenamePage();

  // Opening any page makes its space the active one, so the sidebar follows —
  // including when arriving from cross-space search or a share link.
  //
  // #965: keyed on the OPEN PAGE, not on `openSpaceId`'s value. The effect used to reassert
  // `openSpaceId` on every fire, and it fires more often than "the reader opened a page" — a background
  // refetch elsewhere in the tree is enough (measured: creating a space from the sidebar while this page
  // stayed open invalidates caches this component does not itself read, and the very next fire of THIS
  // effect wrote the open page's space back over the space the sidebar had just switched to, with no
  // navigation in between). The ref remembers which page this effect last acted for, so a re-fire for
  // the SAME page — for any reason — is a no-op; only an actual navigation to a different page updates
  // it, which is the one event the comment above describes.
  const { setActiveSpaceId } = useActiveSpace();
  const openSpaceId = page?.spaceId;
  const spaceAppliedForPageRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const decision = openSpaceForPageDecision(spaceAppliedForPageRef.current, pageId, openSpaceId);
    if (decision.apply) {
      spaceAppliedForPageRef.current = decision.appliedFor;
      setActiveSpaceId(decision.spaceId);
    }
  }, [pageId, openSpaceId, setActiveSpaceId]);

  // #336 part B: the sidebar's unpublished-changes dot reads from the ["pages"] list, which has NO poll —
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
  const onHeadings = useCallback((h: Heading[]) => setHeadings((prev) => (sameHeadings(prev, h) ? prev : h)), []);
  const onActiveHeading = useCallback((f: number | null) => setActiveHeading(f), []);
  const onVisibleHeadings = useCallback((f: number[]) => setVisibleHeadings(f), []);
  // #313: /p/:id#<slug> deep link — once the doc's headings include the hash slug, land on it via the
  // same band-aware TOC jump a rail click uses.
  const tocJump = useCallback((f: number) => tocJumpRef.current?.(f), []);
  useHeadingHashLanding(headings, tocJump);
  // #290 / ADR-114 (A): the page's live GFM-checkbox progress → a ring in the title band. Editor fires this
  // (display-only, dedup'd, like onHeadings — NOT the dirty-signal path), the title band shows it.
  const [taskProgress, setTaskProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const onTaskProgress = useCallback((p: { done: number; total: number }) => setTaskProgress((prev) => (prev.done === p.done && prev.total === p.total ? prev : p)), []);
  // #192: scroll-activity fan-out — the editor fires onScrollActivity on each scroll; the narrow-screen
  // TOC overlay subscribes to show itself while scrolling. A ref'd Set (not state) so scrolling never
  // re-renders the route; the callbacks are stable so <Editor>'s memo holds.
  const tocScrollListeners = useRef(new Set<() => void>());
  const onScrollActivity = useCallback(() => { tocScrollListeners.current.forEach((fn) => fn()); }, []);
  const subscribeTocScroll = useCallback((fn: () => void) => { tocScrollListeners.current.add(fn); return () => { tocScrollListeners.current.delete(fn); }; }, []);
  // External dirty store (instant Publish enable) — read only by PageToolbar, written
  // only by the editor's Y.Text observer; never re-renders PageRoute/Editor.
  const dirtySig = useRef(createDirtySignal()).current;
  // #994 / ADR-276: the SECOND store — "an edit exists that never reached the collab server", which
  // is a different question from `dirtySig`'s "the draft diverges from the published snapshot" (that
  // one stays true for the whole life of an unpublished draft, so gating "not saved" on it would
  // fire on every brief disconnect for any page with a draft). Written from `collab.ts` via the
  // Editor; read here, where the toast already lives.
  const unsyncedSig = useRef(createUnsyncedSignal()).current;
  const unsynced = useUnsynced(unsyncedSig);
  const onUnsyncedChanges = useCallback((v: boolean) => unsyncedSig.set(v), [unsyncedSig]);
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

  // #464 rework slice 2: page analytics as a RIGHT panel (was a static block at the editor's bottom the
  // user couldn't find). Same right-panel zone + #206 exclusion as comments/history. Non-persisted (opened
  // deliberately, like related). The panel itself is manager/entitled-gated by the endpoint it reads.
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const toggleAnalytics = () => {
    const willOpen = !analyticsOpen;
    setAnalyticsOpen(willOpen);
    if (willOpen) closeOtherRightPanels("analytics");
  };
  const closeAnalytics = useCallback(() => setAnalyticsOpen(false), []);

  // #206: mutual exclusion — only one right panel (comments / history / attachments / related / analytics)
  // is open at a time. Opening one closes the others (and clears their persisted-open flag).
  const closeOtherRightPanels = (keep: "comments" | "history" | "attachments" | "related" | "analytics") => {
    if (keep !== "comments") { setCommentsOpen(false); try { localStorage.setItem("wks.commentsOpen", "0"); } catch { /* no storage */ } }
    if (keep !== "history") { setHistoryOpen(false); try { localStorage.setItem("wks.historyOpen", "0"); } catch { /* no storage */ } }
    if (keep !== "attachments") setAttachmentsOpen(false);
    if (keep !== "related") setRelatedOpen(false);
    if (keep !== "analytics") setAnalyticsOpen(false);
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
  const activeSpace = useResolvedSpace(spaceId); // #710: by id, not by roster membership
  const deleteMode = activeSpace?.deleteMode ?? "trash_only";
  const duplicatePage = useCreatePage(); // #229/#242: "Duplicate page" → new page seeded from this one
  const navigate = useNavigate();

  // Edit mode + layout are owned here now (PageToolbar is the chrome). editing
  // starts true for the create-page flow (?edit=1). layout (single/split) persists.
  const canEdit = capability === "edit";
  const [editing, setEditing] = useState(autoEdit);
  // Navigating to another page opens it in READ mode (unless ?edit=1) — PageRoute is
  // not remounted on a param change, so reset editing when the page changes.
  // #994 / ADR-276 owner ruling ③: `unsyncedSig` resets on the page switch in the SAME effect as
  // `dirtySig`. The latch itself is rebuilt anyway (`<Editor key={docName}>` remounts and `connect()`
  // makes a new one), but this route holds ONE store across every page, so without the reset the
  // previous page's value would ring the next page's toast in the window before the new connection
  // reports — including on a page the member can only VIEW, where nothing ever reports at all.
  useEffect(() => { setEditing(autoEdit); dirtySig.set(false); unsyncedSig.set(false); }, [pageId, autoEdit, dirtySig, unsyncedSig]);
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
  // #633 the grid follows the edit surface, not the page. Cleared on unmount so navigating away
  // mid-edit does not leave the marker behind on a page nobody is editing.
  useEffect(() => { reflectEditing(editing); return () => reflectEditing(false); }, [editing]);
  useVimToggleShortcut(toggleVim, editing, resolveKey("editor.toggleVim", keybindings)); // (#2)
  const { showVimToggle, visibleModes } = useEditorChrome(); // #289 / ADR-115: per-user chrome visibility
  const [displayMode, cycleDisplayMode, setDisplayMode] = useMemberDisplayMode(visibleModes); // ADR-056 / #164 (startup pref + device-local)
  useDisplayModeShortcut(cycleDisplayMode, editing, resolveKey("editor.cycleDisplayMode", keybindings));
  const isDesktop = useMediaQuery("(min-width: 768px)"); // 3 floating groups vs one ⋯
  const isWide = useMediaQuery("(min-width: 1200px)"); // #192: enough right whitespace for the TOC rail
  // #406 S4 / ADR-159 (e): a coarse pointer (touch = soft keyboard) forces the EFFECTIVE vim off —
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
  // #538: depend on `publish.mutate`, NOT on the mutation OBJECT. react-query returns a fresh object every
  // render, so a callback listing it is rebuilt every render — and this one is handed to the memoised
  // <Editor>, whose memo then misses. Measured on scroll: `onPublish` and `onToggleTask` were the only two
  // props changing identity, and they re-rendered the whole editor twice per scroll step. `mutate` /
  // `mutateAsync` are stable across renders, which is exactly what a dependency list wants.
  const publishMutate = publish.mutate;
  // #813 / ADR-248 §3.1: the connection's own report, kept as state because the BAND has to render
  // from it. Connection events are rare (a handful in a session), and `<Editor>`'s memo holds through
  // a host re-render because every prop it is handed is stable — which is the property #448 already
  // established for this route and the reason the callback below is `useCallback([])`.
  const [liveness, setLiveness] = useState<Liveness>({ live: false, reason: "connecting" });
  const onLiveness = useCallback((s: Liveness) => setLiveness(s), []);
  // Read by `publishPage`, which is `useCallback`-stable on purpose (#538 / #448) and therefore
  // cannot close over the state value without going stale.
  const livenessRef = useRef(liveness);
  livenessRef.current = liveness;
  // #978 / ADR-261: the band that used to sit above the surface is now this dismissible toast.
  // #978 / #994 ADR-276: what the toast may say is decided in ONE place, `toastReason` —
  // view-only is silent, read-only speaks at once, everything else waits for a real unsent edit.
  useNotLiveToast(`notlive:member:${pageId}`, toastReason({ canEdit, reason: liveness.reason, unsynced }), liveness.live);

  // #911 user ruling: `:w` saves and stays in the edit surface; `:wq` and the toolbar Publish button
  // save and return to the rendered view. One publish path (still fire-and-forget, still #448-stable),
  // parameterised by whether success leaves the surface — never two copies of the mutation call.
  const publishPage = useCallback((opts?: { stay?: boolean }) => {
    if (!canEdit) return;
    // #813 / ADR-248 §3.3: withheld while the edits are not arriving — for members too, which is the
    // half the report did not cover. A member's socket dies the same way; the reason the demo found
    // it as a guest is that only a guest's credential expires on a timer. Publishing here would
    // snapshot a draft missing everything typed since, and say "published".
    // #978: this return used to be silent — the band above was the only word of it, and once
    // the band becomes a dismissible toast a reader who already dismissed it would click Publish
    // into total silence. Pair the withholding with its own toast so the click is never mute.
    if (!livenessRef.current.live) { notify.error(t("toast.publishBlockedNotLive")); return; }
    publishMutate(undefined, {
      onSuccess: () => { dirtySig.set(false); if (!opts?.stay) setEditing(false); notify.success(t("toast.published")); },
      onError: () => notify.error(t("toast.publishFailed")),
    });
  }, [canEdit, publishMutate, dirtySig, t]);
  const publishPageStay = useCallback(() => publishPage({ stay: true }), [publishPage]); // vim :w
  const exitEdit = useCallback(() => setEditing(false), []); // vim :q

  // View-mode task-checkbox toggle (ADR-019). Edit-capable only (D3 UI layer; the
  // server is the bastion). Returns the mutation promise so the editor can revert its
  // optimistic draft flip on failure (409 dirty/mixed, 403); a content edit mixed into
  // the draft is rejected, never silently published. Stable so <Editor>'s memo holds.
  const toggleTask = useToggleTask(pageId ?? "");
  const toggleTaskAsync = toggleTask.mutateAsync; // #538: stable across renders (see publishPage above)
  const onToggleTask = useCallback(
    (index: number, applyFlip: () => void, checked: boolean) =>
      toggleTaskAsync({ index, applyFlip, checked }).then(() => undefined).catch((e) => {
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
        // #830: the opposite of a burst. `task_not_stored` means the flip never reached the draft —
        // the live document could not carry it — so the tick on screen stands for nothing and the
        // rethrow below is what puts it back. It gets its own sentence: "publish first" is wrong
        // advice here, because there is nothing to publish.
        const notStored = err?.status === 409 && err.code === "task_not_stored";
        const dirty = err?.status === 409 && !notStored;
        notify.error(t(notStored ? "toast.taskToggleNotStored" : dirty ? "toast.taskToggleDirty" : "toast.actionFailed"));
        throw e; // let the editor revert the optimistic flip
      }),
    [toggleTaskAsync, t],
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

  // These three are HOOKS and must run on every render, so they sit ABOVE the early returns below. They
  // were introduced under them, which changed the hook count between the loading render and the loaded one
  // — React threw "Rendered more hooks than during the previous render" and the app rendered NOTHING in
  // cookie-auth mode, where the first render is always the loading one. The dev-token path skips that
  // render, which is why it looked fine.
  // #85 / ADR-194: what the export and print build FROM. The published body when there is one — that is
  // what "export this page" has always meant — and otherwise the live document, so a draft prints as itself
  // instead of falling back to printing the application. Reading the surface (a getter the editor sets) is
  // what makes that possible without a published version to fetch.
  const docTextRef = useRef<(() => string) | null>(null);
  // #505 review rejection: the export must be able to ask the host for a diagram it cannot draw itself
  // (plantuml renders server-side). Without this the file carried the fence source while the screen showed
  // the picture. Same renderer the editing surface is given.
  const exportHosts = useMemo(() => (pageId ? { diagram: {
    handles: (lang: string) => lang === "plantuml",
    // #207 PAPER hosts render LIGHT, always — the server injects a dark `!theme` into the
    // plantuml source when asked (#342), and a dark-baked figure on a light page is the defect.
    // The SCREEN's renderer (Editor's own wiring) keeps following the theme.
    render: (lang: string, source: string) => makeDiagramRenderer(token, pageId)(lang, source, "light"),
  }, transclude: {
    // #85 (review rejection): `:::embed-page` declares `exportFidelity: "preserve"`, and a file that
    // says "loading" forever keeps none of it. The export gets the SAME resolver the editing surface is
    // given — the screen and the file answer from one place, which is the whole shape of Option B.
    resolve: makeTranscludeResolver(token, pageId),
    // the SAME sentence the live surface uses for a denied / cyclic / absent embed — a file that invents
    // its own wording is a second vocabulary for the same fact (#600).
    deniedLabel: deniedEmbedLabel(),
  } } : undefined), [pageId, token]);
  const exportSource = useCallback((): string => {
    const pub = published?.publishedMd ?? "";
    if (pub.trim()) return pub;
    return docTextRef.current?.() ?? "";
  }, [published?.publishedMd]);

  // Ctrl+P fell to the print stylesheet over the client portal. Two roads means two things to keep in
  // parity, which is exactly the drift this work keeps finding. Send the shortcut down the same road; the
  // portal remains only as the fallback for a page with no published body.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "p" && e.key !== "P") return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (!pageId) return; // no page in view → let the browser do whatever it does
      e.preventDefault();
      // #85 / ADR-194: the same document the menu's Print produces, so the shortcut cannot print something
      // else. A page with no published body still falls to the live surface (see onPrint).
      const md = exportSource();
      if (md.trim()) void printBrowserExport(md, page?.title ?? "Untitled", exportHosts);
      else window.print();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageId, token, exportSource, page?.title]);

  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  // A page that doesn't exist or isn't accessible must NOT present an editable phantom surface (it would
  // have no space → unpublishable). #262: the server now returns a uniform 404 for both "no such page" and
  // "no view access" (existence-hiding), so the client shows ONE not-found state — a "no permission"
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
  // #505 / ADR-191: the browser's own Ctrl+P used to take a DIFFERENT road to paper than the app's print
  // action — the menu item renders the page server-side (export.html, every macro static) while a native


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
    pageId, // #320 / ADR-126: enables the watch (bell) toggle (member surface only — the guest shell omits it)
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
    onAnalytics: page?.canManage && pageId ? toggleAnalytics : undefined, // #464: manager-only analytics right panel
    onExport: () => { if (pageId) void downloadPageExport(token, pageId); },
    // #85 / ADR-194 (Option B): the file is written by THIS browser, out of the document it already draws —
    // the app's own renderer and the app's own stylesheet, so the export cannot look like a different
    // product than the screen it came from. That is also how diagrams reach it as diagrams and code reaches
    // it highlighted: they are already that way here. The server route stays for the API path (no browser
    // to draw with), and nothing the server serves to anyone else changes.
    onExportHtml: () => {
      const md = exportSource();
      if (md.trim()) void downloadBrowserExport(md, page?.title ?? "Untitled", exportHosts);
      else if (pageId) void downloadPageExport(token, pageId, "html"); // nothing on screen either → the server answers
    },
    // Print takes the SAME road as the download — the sheet and the file are the same document, so there is
    // nothing left to keep in parity between them. A page with no published body still prints the live
    // surface, which is what it did before; giving drafts a rendered export is the next slice.
    onPrint: () => {
      const md = exportSource();
      if (md.trim()) void printBrowserExport(md, page?.title ?? "Untitled", exportHosts);
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
                {/* #329 / ADR-139: freeze badge (staged edit lock) beside the title. Shown to any viewer —
                    freeze only removes access, so the badge reveals nothing; the title attribute names the level. */}
                {page?.frozen && (
                  <Snowflake size={16} className="mt-1 flex-none self-start text-fg-dim" data-testid="title-frozen-badge"
                    aria-label={page.frozen === "full" ? t("page.frozenFull") : t("page.frozenGuests")}>
                    <title>{page.frozen === "full" ? t("page.frozenFull") : t("page.frozenGuests")}</title>
                  </Snowflake>
                )}
                <div className="min-w-0 flex-1">
                  {/* #364 the space HOME's title is derived from the space name and locked —
                      no rename affordance (pageIdOverride is only ever set when rendering the home at
                      /spaces/:id, and /p/<home-id> canonicalises there). The server refuses the PATCH
                      too (two-layer defense).
                      #364 the home label interpolates the SPACE NAME, never `page.title`. Under
                      ruling A the stored title IS the space name, but a home created before that
                      ruling still carries the baked-in localized home suffix, and feeding THAT into
                      the label produced a doubled home suffix. The sidebar home row always used
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
            <Editor key={docName} docName={docName} pageId={pageId} token={getCollabToken} onLiveness={onLiveness} onUnsyncedChanges={onUnsyncedChanges} collabUrl={COLLAB_URL} user={user} capability={capability} apiToken={token} publishedMd={published?.publishedMd ?? null} editing={editing} vim={effectiveVim} displayMode={displayMode} onUploadImage={onUploadImage} inlineComments={inlineComments} anchorGetterRef={anchorGetterRef} docTextRef={docTextRef} onHeadings={onHeadings} onActiveHeading={onActiveHeading} onVisibleHeadings={onVisibleHeadings} onScrollActivity={onScrollActivity} tocJumpRef={tocJumpRef} onTaskProgress={onTaskProgress} dirtySignal={dirtySig} onExitEdit={exitEdit} onPublish={publishPage} onPublishStay={publishPageStay} onToggleTask={canEdit ? onToggleTask : undefined} />
            {/* #505 the paginating print surface (the live CM body is virtualised → prints one screenful).
                #207: the SAME diagram seam the export gets — without it the browser's own File → Print drew
                a plantuml block as its source while every other road drew the picture. */}
            <PrintSurface md={published?.publishedMd ?? null} title={page?.title ?? ""} diagram={exportHosts?.diagram} />
            {/* #464 / ADR-175 rework slice 2/4: the who-viewed analytics moved OUT of this bottom-of-editor
                spot (the user couldn't find it) into a right panel (analyticsOpen, below) — opened from the
                ⋯ menu, manager-only. The static bottom render is retired. */}
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
              railEnabled={!commentsOpen && !historyOpen && !attachmentsOpen && !relatedOpen && !analyticsOpen}
            />
          </div>
        </div>
        {pageId && commentsOpen && <Suspense fallback={null}><CommentsPanel pageId={pageId} canComment={page?.canComment ?? false} anchorGetterRef={anchorGetterRef} onClose={closeComments} /></Suspense>}
        {pageId && historyOpen && <Suspense fallback={null}><HistoryPanel pageId={pageId} canRestore={capability === "edit"} canModerate={page?.canModerate ?? false} onCompare={openDiff} onClose={closeHistory} /></Suspense>}
        {pageId && attachmentsOpen && <Suspense fallback={null}><AttachmentsPanel pageId={pageId} readOnly={capability !== "edit"} onClose={closeAttachments} /></Suspense>}
        {pageId && analyticsOpen && <Suspense fallback={null}><AnalyticsRightPanel pageId={pageId} onClose={closeAnalytics} /></Suspense>}
        {pageId && relatedOpen && <Suspense fallback={null}><RelatedPanel pageId={pageId} onClose={closeRelated} /></Suspense>}
      </div>
      {pageId && diffRevId && <Suspense fallback={null}><DiffModal pageId={pageId} revId={diffRevId} onClose={closeDiff} /></Suspense>}
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
  // #882: FIVE states now. "unavailable" is the deployment saying "not now" — a rolling restart, a
  // gateway timeout, a request that never arrived. It used to collapse into "denied", so a redeploy
  // told a visitor holding a perfectly good address that their link was dead, which reads as the
  // sender having got it wrong. It is a separate state because the answer is different: wait and try
  // again, rather than ask for a new link.
  const [state, setState] = useState<{ status: "loading" | "denied" | "unavailable" | "password" | "ok"; minted?: GuestToken; error?: "wrong" | "throttled" }>({
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
      // The visitor is standing at the prompt with a password typed. Dropping them to a full-page
      // notice would throw that away, so a transient failure stays here and says so.
      else if (minted === "unavailable") setState({ status: "unavailable" });
      else setState(minted ? { status: "ok", minted } : { status: "denied" });
    // second layer. `fetchGuestToken` resolves for every failure it knows about, but a `.then`
    // with no catch turns anything it does NOT into a page that never leaves the skeleton — the one
    // symptom this ticket is named after. The screen must always land somewhere it can be left from.
    }).catch(() => { setSubmitting(false); setState({ status: "unavailable" }); });
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
      else if (minted === "unavailable") setState({ status: "unavailable" });
      else setState(minted ? { status: "ok", minted } : { status: "denied" });
    }).catch(() => { if (!cancelled) setState({ status: "unavailable" }); }); // as above
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
  // #882: said before the `denied` check, because "not now" must not fall through to "this link is
  // dead". The retry re-runs the exchange with whatever password the visitor already typed.
  if (state.status === "unavailable") {
    return (
      <AppShell>
        <div className="mx-auto mt-16 flex max-w-sm flex-col items-start gap-3 p-4" data-testid="share-unavailable">
          <p className="m-0">{t("share.unavailable")}</p>
          <Button variant="primary" disabled={submitting} data-testid="share-unavailable-retry"
            onClick={() => { setState({ status: "loading" }); attempt(password || undefined); }}>
            {t("share.unavailableRetry")}
          </Button>
        </div>
      </AppShell>
    );
  }
  if (state.status === "denied" || !state.minted) {
    return <AppShell><div style={{ padding: 16 }}>{t("share.invalid")}</div></AppShell>;
  }
  // A space link's token carries a space marker docName (t:<tenant>:s:<spaceId>); show the
  // space's pages (#104). A page link goes straight to the page.
  //
  // #813 / ADR-248 §3.5: the mint becomes a SESSION here, and the session is what everything below
  // holds. The token itself is deliberately not passed down any more — see `GuestSessionHost`.
  return <GuestSessionHost linkId={linkId!} minted={state.minted} />;
}

/**
 * #813 / ADR-248 §3.5: owns one guest session for as long as this share link is open.
 *
 * ⚠️ The session is built ONCE, in a ref, and the two faces it offers are the same objects for the
 * life of the visit. That is the requirement, not a style: the editor keys its collaboration effect
 * and its CodeMirror surface effect on the credential it is handed, and a new identity on either tears
 * down the Y.Doc or every view. A guest who paused mid-sentence would come back to a document that had
 * been thrown away — the thing the renewal exists to prevent.
 *
 * What DOES re-render is the mint's other fields: a link narrowed to `view` while somebody was reading
 * changes what the surface may offer. The token is not part of that news.
 */
function GuestSessionHost({ linkId, minted }: { linkId: string; minted: GuestToken }) {
  const [current, setCurrent] = useState(minted);
  const sessionRef = useRef<GuestSession | null>(null);
  sessionRef.current ??= makeGuestSession(linkId, minted, setCurrent);
  const session = sessionRef.current;
  // Ref-stable by construction — never re-created, so neither effect below ever sees a new identity.
  const getTokenRef = useRef<(() => Promise<string>) | null>(null);
  getTokenRef.current ??= () => session.getToken();
  const apiBearerRef = useRef<(() => string) | null>(null);
  apiBearerRef.current ??= () => session.current();

  const live = { ...current, token: "" }; // the token travels through the session, never as a prop
  return live.docName.includes(":s:")
    ? <GuestSpace minted={live} getToken={getTokenRef.current!} apiBearer={apiBearerRef.current!} registerReconnect={session.onReconnect} />
    : <GuestPage minted={live} getToken={getTokenRef.current!} apiBearer={apiBearerRef.current!} registerReconnect={session.onReconnect} />;
}

// Space-link guest reader-chrome (#245 / ADR-112): show the linked space's page tree in the REAL sidebar
// slot — the guest browses exactly like a member — then open a page in the content area. The tree comes
// from GET /spaces/:id/pages (guest-capable, per-page FGA-gated on the share_link principal), synthesised
// from the token's single space; the member-only GET /spaces is never called (Decision 0). No member
// chrome (switcher/settings/create/rename/delete/unpublished dots) — GuestSidebar renders a read-only tree.
// (Ships only after #244, which stops private pages from appearing in a space-guest's tree.)
function GuestSpace({ minted, getToken, apiBearer, registerReconnect }: { minted: GuestToken; getToken: () => Promise<string>; apiBearer: () => string; registerReconnect: (fn: (() => void) | null) => void }) {
  const { t } = useTranslation();
  // #813: the token is NOT in `minted` any more — it lives in the session. `apiBearer` is read per
  // request (ref-stable, so no effect sees a new identity) and `getToken` is what the socket calls on
  // every connection.
  const token = apiBearer;
  const { docName, capability } = minted;
  const m = /^t:(.+?):s:(.+)$/.exec(docName);
  const tenant = m?.[1] ?? "";
  const spaceId = m?.[2] ?? "";
  const [pages, setPages] = useState<Page[] | null>(null);
  // #500: a failed tree fetch used to be swallowed into an EMPTY tree (`.catch(() => setPages([]))`), so an
  // FGA outage read as "this space has no pages" and derailed real-reviews. Track the error separately
  // so the sidebar can say "couldn't load, retry" instead of lying about emptiness.
  const [pagesError, setPagesError] = useState(false);
  const [space, setSpace] = useState<{ name: string; iconImageUrl: string | null; homePageId?: string | null } | null>(null);
  const landedHome = useRef(false); // #364 ①: default-land on the home ONCE (never re-hijack navigation)
  const [openId, setOpenId] = useState<string | null>(null);
  const [pagesTruncated, setPagesTruncated] = useState(false);

  const refreshPages = useCallback(() => {
    setPagesError(false);
    apiFetch<{ pages: Page[]; truncated: boolean }>(`/spaces/${encodeURIComponent(spaceId)}/pages`, token)
      .then((r) => {
        setPages(r?.pages ?? []);
        // #623 / ADR-220 §6.2: the cap comes with a VISIBLE state. This shell draws the tree
        // unvirtualised and fully expanded, so a link whose tree is too large has to SAY so — a quiet
        // cut would look like a complete tree that is simply missing pages.
        setPagesTruncated(Boolean(r?.truncated));
      })
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
    apiFetch<{ pages: Page[]; truncated: boolean }>(`/spaces/${encodeURIComponent(spaceId)}/pages`, token)
      .then((r) => { if (!cancelled) { setPages(r?.pages ?? []); setPagesTruncated(Boolean(r?.truncated)); } })
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
    // #813: the token field carries nothing now — the session is what holds the credential, and it is
    // handed down beside this rather than inside it.
    ? { token: "", docName: `t:${tenant}:p:${openId}`, capability, readOnly: capability !== "edit" }
    : null;

  return (
    <AppShell
      sidebar={<GuestSidebar pages={pages ?? []} loading={pages == null && !pagesError} space={space ?? undefined} openId={openId} onOpen={setOpenId} onCreate={capability === "edit" ? createGuestPage : undefined} homePageId={space?.homePageId ?? null} error={pagesError} onRetry={refreshPages} truncated={pagesTruncated} />}
      // #449 / ADR-173: the guest gets the SAME search box (Ctrl-K + the header field), wired to their
      // own token and opening hits inside this shell via the tree's open handler. The server forces the
      // link's space scope and gates every hit on the share_link principal — no member chrome leaks here.
      search={<SearchBox guestToken={token()} onNavigate={setOpenId} />}
    >
      {pageMinted ? (
        // key on the page id so switching pages in the tree remounts the editor cleanly. A page this
        // guest JUST created opens straight in edit mode (member new-page parity); onTitleChange
        // refreshes the tree so the rename shows up without a reload.
        <GuestPageContent registerReconnect={registerReconnect} key={openId} minted={pageMinted} getToken={getToken} apiBearer={apiBearer} startEditing={openId === createdId} onTitleChange={refreshPages} />
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
function GuestPageContent({ minted, getToken, apiBearer, registerReconnect, onBack, startEditing = false, onTitleChange }: { minted: GuestToken; getToken: () => Promise<string>; apiBearer: () => string; registerReconnect: (fn: (() => void) | null) => void; onBack?: () => void; startEditing?: boolean; onTitleChange?: () => void }) {
  const { t } = useTranslation();
  // #813: the token is NOT in `minted` any more — it lives in the session. `apiBearer` is read per
  // request (ref-stable, so no effect sees a new identity) and `getToken` is what the socket calls on
  // every connection.
  const token = apiBearer;
  const { docName, capability } = minted;
  const pageId = docName.replace(/^t:.+?:p:/, "");
  // #914: paste / drop / the image command, for an edit-link guest only (the member surface builds the
  // same uploader from its space id).
  const onUploadImage = useMemo(() => guestImageUploader(capability, pageId, token), [capability, pageId, token]);
  // Anonymous guest identity (never an OIDC account / seat — the project design notes). Guests have
  // no real name → labelled "Guest"; each session gets a distinct auto colour (no
  // picture) so multiple guests on a doc are still visually distinguishable (#8).
  const [guest] = useState(() => ({ name: t("collab.guest"), color: colorFromString(`guest-${Math.random()}`), picture: null }));
  const [publishedMd, setPublishedMd] = useState<string | null>(null);
  // #917: the same draft-vs-published fact the member surface reads from `usePublished` — the server's
  // `getPublished` already computes and returns it for a view-capable guest too (`guest: 'view'`), it was
  // just never captured into guest state.
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(false);
  // #457 has the FIRST /published fetch settled? Until it has, the body area is "loading", not
  // "empty" — the same distinction the member surface draws. Set on BOTH resolve and deny/expire (a
  // denied guest sees the empty view, not an eternal skeleton).
  const [publishedLoaded, setPublishedLoaded] = useState(false);
  const [pageTitle, setPageTitle] = useState(""); // #318: shown in the guest title band (read-only)
  // #364 a space's HOME page is labelled by its space everywhere else — the sidebar's home row, the
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
  const onHeadings = useCallback((h: Heading[]) => setHeadings((prev) => (sameHeadings(prev, h) ? prev : h)), []);
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
  // #633 the guest surface answers the same way — a share link is where most anonymous editing
  // happens, and vim is device-local there because a guest has no profile to read one from.
  useEffect(() => { reflectEditing(editing); return () => reflectEditing(false); }, [editing]);
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
    apiFetch<{ title?: string; isHome?: boolean; publishedMd: string | null; canComment?: boolean; hasUnpublishedChanges?: boolean }>(`/pages/${encodeURIComponent(pageId)}/published`, token)
      .then((r) => { setPublishedMd(r?.publishedMd ?? null); setPageTitle(r?.title ?? ""); setIsHome(!!r?.isHome); setCanComment(!!r?.canComment); setHasUnpublishedChanges(!!r?.hasUnpublishedChanges); })
      .catch(() => { /* denied/expired → empty view */ })
      .finally(() => setPublishedLoaded(true));
  }, [pageId, token]);
  useEffect(() => { reloadPublished(); }, [reloadPublished]);
  // #917: the member surface's `usePublished` polls every 1500ms so the badge catches an edit without a
  // reload (routes.tsx's own note on that: presence-safe, a SERVER poll, never an editor signal — driving
  // this off `dirtySignal` instead would regress the presence e2e, memory editor-dirty-presence-constraint).
  // The guest surface has no such poll at all; only while actually editing does re-checking make sense —
  // a view-only guest, or one who isn't typing, has no draft to diverge.
  useEffect(() => {
    if (!editing || !canEdit) return;
    const id = setInterval(reloadPublished, 1500);
    return () => clearInterval(id);
  }, [editing, canEdit, reloadPublished]);
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

  // #318: publish the guest band's ACTUAL height as --wks-band-h on the editor's positioning parent —
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
    (index: number, applyFlip: () => void, checked: boolean) => {
      pendingTogglesRef.current += 1;
      const settle = () => {
        pendingTogglesRef.current -= 1;
        if (pendingTogglesRef.current === 0) reloadPublished();
      };
      applyFlip(); // #361 no serial chain — the draft flip and the POST fire on the click frame
      // #830: the state the box is moving TO travels with the index, so the server can tell a folded
      // flip from one that never arrived. The guest surface needs this more than the member one does: a
      // guest's token expires on a timer, so its live document is the one that goes quiet (#813).
      // ⚠️ `checked` is the PRE-click state, so the state being moved to is its negation.
      return apiFetch<{ publishedAt: string | null }>(`/pages/${encodeURIComponent(pageId)}/tasks/toggle`, token, {
        method: "POST",
        body: JSON.stringify({ index, to: !checked }),
      }).then(() => { settle(); }).catch((e) => {
        settle();
        const err = e as { status?: number; code?: string } | null;
        if (err?.status === 409 && err.code === "task_burst") return undefined; // transient — never undo the user's flip
        const notStored = err?.status === 409 && err.code === "task_not_stored";
        const dirty = err?.status === 409 && !notStored;
        notify.error(t(notStored ? "toast.taskToggleNotStored" : dirty ? "toast.taskToggleDirty" : "toast.actionFailed"));
        throw e; // let the editor revert the optimistic flip
      });
    },
    [pageId, token, reloadPublished, t],
  );

  // #448: STABLE (useCallback) so the Editor's mount-captured vim-ex wiring (:w/:wq) can hold it —
  // the server publish route is ALREADY guest:'edit' (#328/ADR-140: FGA edit gate + guest rate cap +
  // abuse filter + anonId attribution); only this client wiring was missing.
  // #813 / ADR-248 §3.1: THE surface the accident was reported on. A guest wrote a page, waited past
  // the token's five minutes, typed, pressed publish, and was told it was published over a draft the
  // socket had stopped carrying.
  const [liveness, setLiveness] = useState<Liveness>({ live: false, reason: "connecting" });
  const onLiveness = useCallback((s: Liveness) => setLiveness(s), []);
  const livenessRef = useRef(liveness);
  livenessRef.current = liveness;
  // #994 / ADR-276: member-surface parity. No page-switch reset here — `GuestPageContent` remounts
  // per page (see `dirtySig` below), so the store is new on every page anyway.
  const unsyncedSig = useRef(createUnsyncedSignal()).current;
  const unsynced = useUnsynced(unsyncedSig);
  const onUnsyncedChanges = useCallback((v: boolean) => unsyncedSig.set(v), [unsyncedSig]);
  // #978 / ADR-261: the band that used to sit above the surface is now this dismissible toast.
  // #978 / #994 ADR-276: the same one place decides what the toast may say — see the member
  // surface's call site.
  useNotLiveToast(`notlive:guest:${pageId}`, toastReason({ canEdit, reason: liveness.reason, unsynced }), liveness.live);
  // #917: member-surface parity (routes.tsx's own `dirtySig`) — an external store the Editor's DOM
  // `input` listener flips optimistically, read by `PageActions`/`PageControlsMobile`'s `useDirty`.
  // `GuestPageContent` remounts fresh per page (`key={openId}` at its GuestSpace call site, or a whole
  // new mount per page-link route), so unlike the member surface there is no page-switch reset to wire.
  const dirtySig = useRef(createDirtySignal()).current;

  // #911 user ruling: `:w` saves and stays; `:wq` and the toolbar button save and return to view.
  const onPublish = useCallback(async (opts?: { stay?: boolean }) => {
    // Read at the click, from a ref: this callback is `useCallback`-stable so the editor's
    // mount-captured `:w` wiring can hold it (#448), which is exactly what makes a closed-over value
    // stale here.
    // #978: pair the withholding with its own toast — see the member surface's publishPage.
    if (!livenessRef.current.live) { notify.error(t("toast.publishBlockedNotLive")); return; }
    setPublishing(true);
    try {
      await apiFetch(`/pages/${encodeURIComponent(pageId)}/publish`, token, { method: "POST" });
      notify.success(t("toast.published"));
      dirtySig.set(false); // #917: member-surface parity — a fresh publish has nothing left to diverge
      if (!opts?.stay) setEditing(false); // publish = done → back to the rendered view
    } catch {
      notify.error(t("toast.publishFailed"));
    }
    setPublishing(false);
    reloadPublished();
  }, [pageId, token, t, reloadPublished, dirtySig]);
  // #448: vim :w/:wq/:q parity with the member surface — publish must be fire-and-forget for the
  // Editor's () => void contract; :q exits edit mode without publishing.
  const publishForEditor = useCallback(() => { void onPublish(); }, [onPublish]);
  const publishForEditorStay = useCallback(() => { void onPublish({ stay: true }); }, [onPublish]); // vim :w
  const exitEdit = useCallback(() => setEditing(false), []);
  // #915: the member surface's title-band ring, wired here too. A view-linked guest gets it as well
  // (unlike onToggleTask, which stays edit-only) — the progress is derived from the published body
  // they can already read, not a new disclosure, and #290's ProgressRing already renders nothing at
  // 0/0 so an untouched page shows no ring, same as the member surface.
  const [taskProgress, setTaskProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const onTaskProgress = useCallback((p: { done: number; total: number }) => setTaskProgress((prev) => (prev.done === p.done && prev.total === p.total ? prev : p)), []);

  // #917: guests never see "draft" — that state is "created but never published", a member-only concept
  // (a guest's edit link always points at an already-published page, or one a guest just created and
  // immediately holds edit access to, which is "unpublished" the instant it diverges, not "draft").
  const publishState: "unpublished" | null = canEdit && hasUnpublishedChanges ? "unpublished" : null;

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
    // #917: the badge member parity — see `publishState` above.
    publishState,
    canPublish: true,
    onPublish: canEdit ? publishForEditor : undefined,
    publishing,
    // #100: comments toggle — shown to any guest who can VIEW (reading is guest:'view'); the composer
    // inside the panel is gated on canComment (comment_open). openComments count is member-only chrome.
    commentsOpen,
    onToggleComments: () => setCommentsOpen((o) => !o),
    tocOpen: tocOn,
    onToggleToc: () => setTocOn(!tocOn),
    // #917: member-surface parity — see `dirtySig` above.
    dirtySignal: dirtySig,
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
                  {/* #915: member parity (the band's own row below the title, mirroring where PageMeta
                      carries the ring on the member surface) — onToggleTask is edit-only, but the
                      progress itself is derived from the published body a view guest already reads, so
                      the ring rides here for both capabilities. ⚠️ #915 (review rejection): the ROW is
                      gated, not just the ring — a null ring leaves an empty row whose mt-1 is 4 real
                      px, and only here, since the member row carries PageMeta beside it. */}
                  {taskProgress.total > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="mt-1 inline-flex self-center" data-testid="band-task-ring"><ProgressRing done={taskProgress.done} total={taskProgress.total} animKey={pageId} /></span>
                    </div>
                  )}
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
            {/* #457 the guest body gets the SAME loading/empty distinction as the member surface —
                the identical opaque inset-0 overlay (the lesson: it must fully cover the mounted
                Editor so the skeleton and real content never show together). The Editor stays mounted
                underneath (collab/presence invariant), exactly like the member wiring above. */}
            <BodyPlaceholder
              loading={!publishedLoaded && !editing}
              empty={publishedLoaded && !editing && !(publishedMd ?? "").trim()}
              canEdit={canEdit}
            />
            <Editor key={docName} docName={docName} pageId={pageId} guestSurface token={getToken} onLiveness={onLiveness} onUnsyncedChanges={onUnsyncedChanges} registerReconnect={registerReconnect} collabUrl={COLLAB_URL} user={guest} capability={capability} apiToken={token} publishedMd={publishedMd} editing={editing} vim={effectiveVim} displayMode={displayMode} onUploadImage={onUploadImage} onHeadings={onHeadings} onActiveHeading={onActiveHeading} onVisibleHeadings={onVisibleHeadings} onScrollActivity={onScrollActivity} tocJumpRef={tocJumpRef} onTaskProgress={onTaskProgress} onExitEdit={exitEdit} onPublish={canEdit ? publishForEditor : undefined} onPublishStay={canEdit ? publishForEditorStay : undefined} onToggleTask={canEdit ? onToggleTask : undefined} dirtySignal={dirtySig} />
            {/* #505 the paginating print surface (guest CM body is virtualised too).
                #207: a guest holds a share token, which the diagram route accepts, so the picture prints
                here as well. (The public route below has no token and passes none — its plantuml degrades
                to its source, the same as it does on that page's screen.) */}
            <PrintSurface md={publishedMd} title={pageTitle} diagram={pageId ? {
              handles: (lang: string) => lang === "plantuml",
              // #207 paper renders light (same pin as the member surface above)
              render: (lang: string, source: string) => makeDiagramRenderer(token, pageId)(lang, source, "light"),
            } : null} />
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
          {commentsOpen && <Suspense fallback={null}><CommentsPanel pageId={pageId} canComment={canComment} anchorGetterRef={anchorGetterRef} onClose={() => setCommentsOpen(false)} token={token()} /></Suspense>}
        </div>
      </div>
  );
}

// Page-link guest route: a single page, NO space tree (a page-scoped link grants no authority to traverse
// the space — #245 / ADR-112 Decision 3). Chrome-less AppShell wrapping the page content.
function GuestPage({ minted, getToken, apiBearer, registerReconnect }: { minted: GuestToken; getToken: () => Promise<string>; apiBearer: () => string; registerReconnect: (fn: (() => void) | null) => void }) {
  return <AppShell><GuestPageContent registerReconnect={registerReconnect} minted={minted} getToken={getToken} apiBearer={apiBearer} /></AppShell>;
}

// Cloud signup landing (platform origin). Public — no session yet. Starts the
// platform-IdP flow as a top-level navigation to /signup/login (proxied to the API).
function JoinRoute() {
  const { t } = useTranslation();
  const productName = useProductName();
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>{t("auth.joinTitle", { product: productName })}</h2>
        <p style={{ color: "var(--fg-dim)" }}>{t("auth.joinBody")}</p>
        <Button variant="primary" onClick={() => { window.location.href = "/signup/login"; }}>{t("auth.signUp")}</Button>
      </div>
    </AppShell>
  );
}

/**
 * #806: which sentence the workspace-name step shows when the create step does not succeed.
 *
 * A 404 is not a failed attempt. It says this deployment does not offer self-serve creation at all —
 * no workspace-address template, or no platform identity provider — and the person in front of the
 * form should stop retrying and ask for an invitation instead. Before this ticket a 404 was
 * unreachable for a deployment that had an identity provider, so the branch did not exist.
 *
 * #871: and now the rest of them. `POST /signup/tenants` answers five ways, and four of them were
 * reaching the screen as the server's own English — written for an API client, by a route that has no
 * idea who is reading. The one a person meets most is 409, because names are taken by other people.
 *
 * ⚠️ The body's `error` string is no longer rendered at all, on any status. Keeping it as the
 * fallback would have left the defect wherever a status was not listed, which is the same thing as
 * leaving it: the fallback is the generic sentence, which is at least in the reader's language. The
 * server keeps its strings for API clients and for the log; the screen keeps the copy.
 *
 * ⚠️ What this does NOT decide: whether "that name is taken" belongs under the input rather than in
 * the red line above it. That is a question about the shape of the form, not the words, and it is
 * left on the ticket for whoever owns it.
 *
 * Exported so the rule is measured by running it, not by reading the file it lives in.
 */
export function createWorkspaceMessage(
  status: number,
  _body: { error?: string },
  t: (key: string) => string,
): string {
  if (status === 404) return t("auth.signupUnavailable");
  if (status === 409) return t("auth.workspaceNameTaken");
  if (status === 400) return t("auth.workspaceNameInvalid");
  if (status === 401) return t("auth.signupSessionExpired");
  return t("auth.createWorkspaceError");
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
    setErr(createWorkspaceMessage(res.status, body, t));
    setBusy(false);
  };
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>{t("auth.workspaceTitle")}</h2>
        <p style={{ color: "var(--fg-dim)" }}>{t("auth.workspaceBody")}</p>
        <label className="flex flex-col gap-1 text-xs text-fg-dim">
            {t("auth.workspaceName")}
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t("auth.workspacePlaceholder")} />
          </label>
        {err && <p style={{ color: "crimson" }}>{err}</p>}
        <Button variant="primary" disabled={busy || !slug} onClick={submit}>{t("auth.createWorkspace")}</Button>
      </div>
    </AppShell>
  );
}

// Invite acceptance landing: the link carries ?token, which is opaque to the SPA — so the page ASKS
// what kind of invite it is before deciding what to offer.
//
// #568 review B2: it used to send everyone to the IdP. A PASSWORD invite followed that path, burned
// its token on a member seated as `identity_source='oidc'`, and never wrote the credential it
// existed to create — silently, for both the person and the admin who sent it.
function InviteRoute() {
  const { t } = useTranslation();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const kind = useQuery({
    queryKey: ["invite-kind", token],
    queryFn: () =>
      fetch(assetUrl(`/auth/invite-kind?token=${encodeURIComponent(token)}`))
        .then((r) => (r.ok ? (r.json() as Promise<{ kind: string }>) : null))
        .catch(() => null),
    enabled: token.length > 0,
    retry: false,
  });
  const accept = () => {
    window.location.href = `/auth/login?invite=${encodeURIComponent(token)}&returnTo=${encodeURIComponent("/")}`;
  };
  // A dead link degrades to the OIDC button rather than a dead end: the token may simply be for a
  // server that does not publish kinds, and the acceptance itself refuses uniformly anyway.
  const isLocal = kind.data?.kind === "local";
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>{t("auth.inviteTitle")}</h2>
        <p style={{ color: "var(--fg-dim)" }}>{isLocal ? t("auth.inviteLocalBody") : t("auth.inviteBody")}</p>
        {isLocal ? (
          <SetPasswordForm token={token} mode="accept" onDone={() => { window.location.href = "/"; }} />
        ) : (
          <Button variant="primary" disabled={!token || kind.isPending} onClick={accept}>{t("auth.acceptInvite")}</Button>
        )}
      </div>
    </AppShell>
  );
}

// #568 / ADR-198 §6: the page a reset link lands on. Unauthenticated by nature — the person is here
// BECAUSE they cannot sign in — so it renders outside the app shell's session assumptions and sends
// them to the login screen when they are done.
function ResetPasswordRoute() {
  const { t } = useTranslation();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [done, setDone] = useState(false);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-sm rounded-xl border border-border bg-panel p-8 shadow-md" data-testid="reset-card">
        <h1 className="mb-1 text-xl font-semibold">{t("auth.resetTitle")}</h1>
        {done ? (
          <>
            <p className="mb-4 text-sm text-fg-dim" data-testid="reset-done">{t("auth.resetDone")}</p>
            <Button variant="primary" className="w-full" onClick={() => { window.location.href = "/login"; }}>
              {t("auth.signIn")}
            </Button>
          </>
        ) : (
          <>
            <p className="mb-4 text-sm text-fg-dim">{t("auth.resetBody")}</p>
            <SetPasswordForm token={token} mode="reset" onDone={() => setDone(true)} />
          </>
        )}
      </div>
    </div>
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
// (#227). ②: a standalone /pub/:id shows ONLY its page (the old bottom child-tree nav is gone —
// page-level publish = just the page; SPACE-level publish is the sidebar shell with the tree).
// #430 the space a public page belongs to — name + (optional) icon, both served publicly.
export interface PublicSpaceContext { name: string; iconImageUrl: string | null }

function PublicPageContent({ pageId, onSpace }: { pageId: string; onSpace?: (s: PublicSpaceContext | null) => void }) {
  const { t } = useTranslation();
  // #886: FOUR states. "unavailable" is the deployment failing, and it is NOT "notfound" — a 502 from
  // a rolling restart used to tell a reader that the address their author shared does not exist, which
  // they have no way to tell apart from a broken link. ⚠️ The 404 is untouched: it is existence-hiding
  // (#227), and a private page must stay indistinguishable from a missing one.
  const [state, setState] = useState<{ status: "loading" | "notfound" | "unavailable" | "ok"; page?: { id: string; title: string; content: string; noindex: boolean; children: PublicChildNode[]; space?: PublicSpaceContext } }>({ status: "loading" });
  // #886: bumping this re-runs the load, which is what the retry on the unavailable view needs. A
  // separate key rather than clearing `pageId`: the page being asked for has not changed.
  const [reloadKey, setReloadKey] = useState(0);
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
        // #886 / #681: the server failing is not an answer about this page. `isServerFault` is the one
        // place that decides, so the five surfaces asking it cannot drift apart.
        if (isServerFault(res)) { setState({ status: "unavailable" }); return; }
        if (!res.ok) { setState({ status: "notfound" }); return; }
        const payload = await res.json();
        setState({ status: "ok", page: payload });
        onSpace?.(payload?.space ?? null); // hoist the space context into the header slot
      })
      // A request that never arrived decides nothing either — same reading, same state.
      .catch(() => { if (!cancelled) setState({ status: "unavailable" }); });
    return () => { cancelled = true; };
  }, [pageId, reloadKey]);

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
        // `.lp-editor-host .cm-content { padding-top: var(--wks-band-h) }`), exactly like the member view —
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

  // #319: hover link-icon heading anchors are now provided by the CM `headingAnchors` extension inside
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
  // #886: said BEFORE the not-found branch, and separately from it. A reader who was handed a working
  // address must not be told the page does not exist because the deployment is restarting.
  if (state.status === "unavailable") {
    return (
      <div data-testid="public-unavailable" style={{ padding: 24, fontFamily: "var(--font-body, sans-serif)" }}>
        <p style={{ margin: 0 }}>{t("publicPage.unavailable")}</p>
        <Button variant="primary" className="mt-3" data-testid="public-unavailable-retry"
          onClick={() => { setState({ status: "loading" }); setReloadKey((k) => k + 1); }}>
          {t("publicPage.unavailableRetry")}
        </Button>
      </div>
    );
  }
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
        {/* #505 the paginating print surface (the public CM body is virtualised too). */}
        <PrintSurface md={page.content} title={page.title} />
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
  const productName = b?.productName || FALLBACK_PRODUCT_NAME;
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
        <span className="text-[11px] text-fg-dim opacity-70" data-testid="powered-by">{t("publicReader.poweredBy", { product: productName })}</span>
      )}
      {/* #429 ruling: theme AND language ride the minimal public header (JA is core to positioning —
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
// (/public/spaces/:id/pages + /public/pages/:id), member routes are never touched (no session → no login
// bounce), and there is NO member chrome (search / user menu / edit / create). A non-public space → 404.
// #227 map the public tree (`/public/spaces/:id/pages` — every node is published + public) onto the
// shared PageTreeNode shape. Published/non-private/ring-less, so the draft/unpublished/private/ring badges all
// collapse. This is the ONLY public-specific code left; the rendering is the member PageTree component itself.
// #623 / ADR-220 §10 (client slice): the public tree fetches BRANCH BY BRANCH, like the member tree.
// The whole-tree route was depth-bounded at 6 and silently dropped the 7th level (pinned as intended
// at the time); per-branch fetching removes that truncation — a deep page becomes reachable by
// expanding its ancestors. The anonymous reader expands rows the way a member does; every row draws a
// chevron from the same sentinel-child device (ruling ①(c)).
interface PublicBranch { pages: { id: string; title: string; hasChildren?: boolean }[]; nextCursor: string | null; home?: { id: string; title: string } | null }

function usePublicLazyTree(spaceId: string | undefined) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const key = (parent: string | null) => ["public-tree", spaceId, parent ?? "root"];

  const root = useQuery({
    queryKey: key(null),
    enabled: !!spaceId,
    retry: 1,
    queryFn: async (): Promise<PublicBranch> => {
      const res = await fetch(assetUrl(`/public/spaces/${encodeURIComponent(spaceId!)}/pages/branch`));
      if (!res.ok) throw new HttpStatusError(res.status); // #886 the status has to survive the rejection
      return (await res.json()) as PublicBranch;
    },
  });
  const branches = useQueries({
    queries: [...expanded].map((parent) => ({
      queryKey: key(parent),
      enabled: !!spaceId,
      staleTime: 30_000,
      queryFn: async (): Promise<PublicBranch> => {
        const res = await fetch(assetUrl(`/public/spaces/${encodeURIComponent(spaceId!)}/pages/branch?parent=${encodeURIComponent(parent)}`));
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as PublicBranch;
      },
    })),
  });
  const byParent = useMemo(() => {
    const m = new Map<string | null, PublicBranch>();
    if (root.data) m.set(null, root.data);
    [...expanded].forEach((parent, i) => { const d = branches[i]?.data; if (d) m.set(parent, d); });
    return m;
  }, [root.data, expanded, branches]);
  const loadMore = useCallback(async (parent: string | null) => {
    const have = qc.getQueryData<PublicBranch>(key(parent));
    if (!have?.nextCursor || !spaceId) return;
    const qs = new URLSearchParams();
    if (parent) qs.set("parent", parent);
    qs.set("cursor", have.nextCursor);
    const res = await fetch(assetUrl(`/public/spaces/${encodeURIComponent(spaceId)}/pages/branch?${qs}`));
    if (!res.ok) return;
    const next = (await res.json()) as PublicBranch & { restarted?: boolean };
    qc.setQueryData<PublicBranch>(key(parent), next.restarted ? next : { ...next, pages: [...have.pages, ...next.pages], home: have.home });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, qc]);
  return {
    root, byParent,
    expand: (id: string) => setExpanded((s) => (s.has(id) ? s : new Set([...s, id]))),
    collapse: (id: string) => setExpanded((s) => { const n = new Set(s); n.delete(id); return n; }),
    loadMore,
  };
}

function toPublicLazyNodes(byParent: ReadonlyMap<string | null, PublicBranch>): PageTreeNode[] {
  const node = (p: { id: string; title: string; hasChildren?: boolean }): PageTreeNode => ({
    id: `page:${p.id}`, name: p.title, pageId: p.id, spaceId: "",
    published: true, unpublished: false, private: false, taskDone: 0, taskTotal: 0,
    children: childrenOf(p),
  });
  // #623 ①: the chevron follows the server's `hasChildren` (a PUBLIC child exists), same as the
  // member tree — a chevron on a childless row is a lie whoever the reader is.
  const childrenOf = (p: { id: string; hasChildren?: boolean }): PageTreeNode[] => {
    const b = byParent.get(p.id);
    if (!b) {
      if (!p.hasChildren) return [];
      return [{ id: `unloaded:${p.id}`, name: "", pageId: "", spaceId: "", published: true, unpublished: false, private: false, taskDone: 0, taskTotal: 0, children: [] }];
    }
    return assemble(b, p.id);
  };
  const assemble = (b: PublicBranch, parent: string | null): PageTreeNode[] => {
    const rows = b.pages.map(node);
    if (b.nextCursor) rows.push({ id: `more:${parent ?? "root"}:${b.nextCursor}`, name: "", pageId: "", spaceId: "", published: true, unpublished: false, private: false, taskDone: 0, taskTotal: 0, children: [] });
    return rows;
  };
  const root = byParent.get(null);
  return root ? assemble(root, null) : [];
}
function PublicSpaceSidebar({ tree, home, openId, onOpen }: { tree: ReturnType<typeof usePublicLazyTree>; home: { id: string; title: string } | null; openId: string | null; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const treeNodes = useMemo(() => toPublicLazyNodes(tree.byParent), [tree.byParent]);
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
      <PageTree nodes={treeNodes} selectedId={openId} onOpen={onOpen}
        onToggleBranch={(id, open) => (open ? tree.expand(id) : tree.collapse(id))}
        onLoadMore={(parentId) => tree.loadMore(parentId)} />
    </div>
  );
}
// #430: the free-plan "Powered by Wikistead" marker for the public SPACE reader's AppShell header
// (the standalone page header renders its own copy inside PublicHeader). Paid/white-label → nothing.
function PublicPoweredBy() {
  const { t } = useTranslation();
  const branding = useBranding();
  const b = branding.data;
  const productName = b?.productName || FALLBACK_PRODUCT_NAME;
  if (!b || b.whitelabel) return null;
  return <span className="text-[11px] text-fg-dim opacity-70" data-testid="powered-by">{t("publicReader.poweredBy", { product: productName })}</span>;
}

function PublicSpaceRoute() {
  const { t } = useTranslation();
  const { spaceId } = useParams<{ spaceId: string }>();
  // #623 §10: one bounded request — the root branch, which carries `home` additively. The whole-tree
  // route (depth-bounded, unbounded in breadth) is no longer called from here.
  const lazy = usePublicLazyTree(spaceId);
  const home = lazy.root.data?.home ?? null;
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (openId || !lazy.root.data) return;
    setOpenId(home?.id ?? lazy.root.data.pages[0]?.id ?? null); // the home is the space root — open it by default
  }, [openId, home, lazy.root.data]);

  // #886 this branch used to answer "the page does not exist" to EVERY failure, so a restarting
  // deployment made a shared /pub/space address look dead — and it sits OUTSIDE PublicPageContent, so
  // the fix that landed there never got to draw. Said before the not-found branch, and separately.
  const treeVerdict = loadVerdict(lazy.root.isError, lazy.root.error);
  if (treeVerdict === "unavailable") {
    return (
      <AppShell>
        <div data-testid="public-space-unavailable" style={{ padding: 24 }}>
          <p style={{ margin: 0 }}>{t("publicPage.unavailable")}</p>
          <Button variant="primary" className="mt-3" data-testid="public-space-retry" onClick={() => { void lazy.root.refetch(); }}>
            {t("publicPage.unavailableRetry")}
          </Button>
        </div>
      </AppShell>
    );
  }
  if (treeVerdict === "notfound") return <AppShell><div data-testid="public-space-not-found" style={{ padding: 24 }}>{t("publicPage.notFound")}</div></AppShell>;
  return (
    <AppShell sidebar={<PublicSpaceSidebar tree={lazy} home={home} openId={openId} onOpen={setOpenId} />} headerExtra={<PublicPoweredBy />}>
      {openId ? (
        <PublicPageContent key={openId} pageId={openId} />
      ) : (
        <div className="flex h-full items-center justify-center p-8 text-fg-dim" data-testid="public-space-empty">
          {lazy.root.data == null ? "" : t("share.spacePickPrompt")}
        </div>
      )}
    </AppShell>
  );
}

// #364 / ADR-157 §5-§6: the space ROOT route — the member landing for a space. Renders the HOME page
// with the FULL page machinery (PageRoute with an override id), or the empty state: the space-name
// heading + a "write the homepage" button visible ONLY to edit-capable viewers (owner ruling 3).
export function SpaceHomeRoute() {
  const { t } = useTranslation();
  const { spaceId } = useParams<{ spaceId: string }>();
  const { status, logout, token } = useSession();
  const spaceState = useResolvedSpaceState(spaceId, status === "authed");
  const spaceResolved = spaceState.data;
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const { setActiveSpaceId } = useActiveSpace();
  // #710: resolved by id — a space on any roster page (or none) answers the same way. null is
  // DEFINITIVE (gone or not visible, uniformly), undefined is still in flight or the fetch failed
  // (spaceState.isError, checked below, tells the two apart).
  const space = spaceResolved ?? undefined;
  // #364 ①: the sidebar follows the URL here, not an opened page. The page-driven sync (PageRoute)
  // never fires for a home-less space (the empty state opens no page), so a direct /spaces/:id link left
  // the sidebar on the previous space. Sync from the RESOLVED space (not the raw param) so a bogus id
  // (the not-found branch) can't hijack the sidebar.
  useEffect(() => { if (space?.id) setActiveSpaceId(space.id); }, [space?.id, setActiveSpaceId]);
  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  // #1014: an exhausted retry on /spaces/resolve used to collapse to the same `undefined` as an
  // in-flight fetch, so it fell all the way through to the space-home-empty panel below — a silent,
  // permanent blank screen with no way to tell it apart from a genuinely home-less space. Checked
  // before the null (definitively-not-found) branch: isError and null are mutually exclusive here,
  // but ordering it first keeps the two failure-shaped branches next to each other.
  if (spaceState.isError) {
    return (
      <AppShell sidebar={<Sidebar />} search={<SearchBox />} onLogout={logout}>
        <LoadFailed testId="space-home-failed" variant="page" onRetry={() => { void spaceState.refetch(); }} />
      </AppShell>
    );
  }
  if (spaceResolved === null) {
    return (
      <AppShell sidebar={<Sidebar />} search={<SearchBox />} onLogout={logout}>
        <div style={{ padding: 24 }} data-testid="page-not-found">{t("page.notFound")}</div>
      </AppShell>
    );
  }
  // #364 hand the RESOLVED space name down. The band must never interpolate `page.title`
  // (a pre-ruling home carries the baked suffix → doubled label), and reading it from a second
  // useSpaces() inside PageRoute would render an empty name on the first frame; this route already
  // has the space in hand, so the label is correct on the FIRST paint.
  if (space?.homePageId) return <PageRoute pageIdOverride={space.homePageId} homeSpaceName={space.name} />;
  const canEdit = space?.capability === "edit" || space?.capability === "manage";
  const createHome = () => {
    if (!spaceId || creating) return;
    setCreating(true);
    void apiFetch<{ id: string }>(`/spaces/${encodeURIComponent(spaceId)}/home`, token, { method: "POST" })
      .then(async (r) => {
        // #845: every cache that holds a Space, not the listing alone. This screen reads the home
        // pointer through `useResolvedSpace` — key `["spaces-resolve", ids]` — and React Query matches
        // key prefixes element by element, so invalidating `["spaces"]` never reached it. The home was
        // created, the empty state stayed on screen, and pressing the button again did the same thing.
        // #737 met this exact mismatch on a space icon and left one way to say it; this call site was
        // written afterwards and said it the old way.
        invalidateSpaces(qc);
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

/**
 * #726 where "/" actually goes.
 *
 * It used to go to `/p/demo` — the id `infra/db/seed.ts` gives the demo page of the DEV tenant. On a
 * workspace created any other way that page does not exist, so a self-hoster's first screen after
 * setting their password was the not-found pane. The fixture id had become the product's home route
 * by being written down five times.
 *
 * What a home IS, asked of the member's own data: the first space they can see, and its home page if
 * it has one. Both facts are already served — `homePageId` is view-gated by the server (ADR-157 §2),
 * so a home page the caller may not read comes back null and this lands on the space instead of
 * bouncing them into a refusal.
 *
 * A member with no space at all is NOT redirected anywhere: there is nowhere honest to send them, and
 * a redirect to a route that redirects back is how a blank screen becomes a spin. They are told.
 */
function HomeLanding() {
  const { t } = useTranslation();
  const spaces = useSpacesPage();
  if (spaces.isPending) return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  // #895: a failed fetch is not zero spaces — without this guard a 500/network failure fell through to
  // HomeEmpty's "no spaces yet, ask an administrator", telling a member their workspace is empty when
  // nothing of the sort was established. Measured on the most-visible surface in the product.
  if (spaces.isError) return <AppShell><LoadFailed testId="home-spaces-failed" variant="page" onRetry={() => { void spaces.refetch(); }} /></AppShell>;
  const first = (spaces.data?.spaces ?? [])[0];
  // #936: AppShell must stay mounted across this redirect, same as every other branch here — a bare
  // <Navigate> renders null for the commit before the target route takes over, unmounting the header
  // (and the brand mark inside it) for one frame on every "/" visit that lands on a real workspace.
  if (first?.homePageId) return <AppShell><Navigate to={`/p/${first.homePageId}`} replace /></AppShell>;
  if (first) return <AppShell><Navigate to={`/spaces/${first.id}`} replace /></AppShell>;
  return (
    <AppShell>
      <HomeEmpty />
    </AppShell>
  );
}

// #808: a member address met by somebody who is NOT signed in shows the door, not an empty desk.
//
// Measured on a cookie-less browser (2026-08-21): `/`, `/templates`, `/changes` and `/watches` each
// answered 401 to every call they made and then rendered the member's own empty state — "no spaces
// yet, ask an administrator", "no templates yet, save one from a page's menu". The visitor is told
// their workspace is empty when the truth is that the workspace has not been shown to them. Two
// sibling routes (a page, a space) had the branch all along; the landing never grew one.
//
// It is invisible in development: `apps/web/.env.development` sets `VITE_DEV_TOKEN`, so the session
// starts "authed" and this path never renders. `VITE_DEV_TOKEN_DISABLE=1` is how it is seen.
function RequireMember({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const { t } = useTranslation();
  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  return <>{children}</>;
}

// The addresses a signed-out visitor may reach, and why. Every other Route is member UI and must be
// wrapped in RequireMember — `anon-routes-808.test.ts` walks the table and requires each entry to be
// one or the other, so a route added later has to say which it is instead of inheriting the empty
// desk. Measured for each of these: a cookie-less visit renders copy written for a signed-out reader.
export const ANONYMOUS_ROUTES: Readonly<Record<string, string>> = {
  "/pub/space/:spaceId": "the public space surface (ADR-030), whose audience is anonymous",
  "/pub/:pageId": "the public page surface, same audience",
  "/share/:linkId": "a share link mints a guest session; the guest never has an account (ADR-107)",
  "/invite": "the invitation carries its own token and is read before signing in",
  "/reset-password": "a reset link works without a session, which is the point (#568)",
  "/login": "the door",
  "/login/recovery": "the break-glass door (#605)",
  "/join": "sign-up starts here, before there is anybody to be",
  "/join/workspace": "naming the new workspace, still before the session exists",
  "*": "the catch-all redirects to /, which is guarded",
};

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/p/:pageId" element={<RequireMember><PageRoute /></RequireMember>} />
      <Route path="/spaces/:spaceId" element={<RequireMember><SpaceHomeRoute /></RequireMember>} /> {/* #364 / ADR-157 §6: the space root */}
      <Route path="/pub/space/:spaceId" element={<PublicSpaceRoute />} />
      <Route path="/pub/:pageId" element={<PublicPageRoute />} />
      <Route path="/share/:linkId" element={<ShareRoute />} />
      <Route path="/invite" element={<InviteRoute />} />
      {/* #568: a reset link lands here — no session required, that is the point */}
      <Route path="/reset-password" element={<ResetPasswordRoute />} />
      <Route path="/templates" element={<RequireMember><Suspense fallback={<LazyFallback />}><TemplatesRoute /></Suspense></RequireMember>} />
      <Route path="/changes" element={<RequireMember><Suspense fallback={<LazyFallback />}><RecentChangesRoute /></Suspense></RequireMember>} />
      <Route path="/watches" element={<RequireMember><Suspense fallback={<LazyFallback />}><WatchListRoute /></Suspense></RequireMember>} /> {/* #362 the bell's watch list */}
      <Route path="/admin/*" element={<RequireMember><Suspense fallback={<LazyFallback />}><AdminRoot /></Suspense></RequireMember>} />
      <Route path="/settings/account/*" element={<RequireMember><Suspense fallback={<LazyFallback />}><AccountRoot /></Suspense></RequireMember>} />
      <Route path="/spaces/:spaceId/settings/*" element={<RequireMember><Suspense fallback={<LazyFallback />}><SpaceSettingsRoot /></Suspense></RequireMember>} />
      {/* Back-compat: the old members URL now lives under the admin console. */}
      <Route path="/settings/members" element={<RequireMember><Navigate to="/admin/members" replace /></RequireMember>} />
      <Route path="/join" element={<JoinRoute />} />
      <Route path="/join/workspace" element={<WorkspaceRoute />} />
      {/* #261: the auth callback redirects failures to /login?error=<kind>. A dedicated route renders the
          sign-in screen so the error query survives (the catch-all below would rewrite it to the home
          landing and drop it). */}
      <Route path="/login" element={<LoginScreen />} />
      {/* #605 §3 (iii): the recovery door — reachable by address, never linked from /login */}
      <Route path="/login/recovery" element={<RecoveryScreen />} />
      {/* #726 the landing RESOLVES, it is no longer a literal.
          `/p/demo` is `infra/db/seed.ts`'s fixture id for `tenant_dev`, and it was written here as
          though it were the product's home — so the first thing an administrator of a real workspace
          saw, immediately after setting their password, was "this page does not exist". The catch-all
          sends unknown addresses to `/`, and `/` asks what this member actually has. */}
      <Route path="/" element={<RequireMember><HomeLanding /></RequireMember>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
