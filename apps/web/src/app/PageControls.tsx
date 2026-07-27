import { useEffect, useState, type ReactNode } from "react";
import { Pencil, Share2, MessageSquare, History, Download, Printer, Shield, SquareTerminal, X, UploadCloud, MoreHorizontal, Paperclip, Trash2, Copy, Eye, EyeOff, Code, BookOpen, Zap, List, FileStack, Check, BarChart3, Link as LinkIcon } from "lucide-react";
import { useWatchState, useToggleWatch } from "../notifications/useNotifications";
import { useTranslation } from "react-i18next";
import { IconButton } from "../ui/Button";
import { ToggleButton } from "../ui/ToggleButton";
import { OverflowMenu, type OverflowItem } from "../ui/OverflowMenu";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "../components/ui/dropdown-menu";
import { useDirty, type DirtySignal } from "../editor/dirtySignal";

// #165 display-mode segment: icon-only entries, in cycle order (matches Ctrl+Alt+E). Icons mirror the
// per-mode glyphs (#493): Live=Zap (instant), Source=Code (raw), Reading=BookOpen (read), WYSIWYG=Eye
// (see-what-you-get — moved off Live, which read as WYSIWYG). Eye also marks the Watch toggle, but the two
// never share a menu (Watch is a ⋯ item, WYSIWYG a display-mode segment).
const DISPLAY_MODES = [
  { mode: "live" as const, Icon: Zap, labelKey: "page.modeLive" },
  { mode: "source" as const, Icon: Code, labelKey: "page.modeSource" },
  { mode: "reading" as const, Icon: BookOpen, labelKey: "page.modeReading" },
  { mode: "wysiwyg" as const, Icon: Eye, labelKey: "page.modeWysiwyg" },
];

// The old full-width top bar is gone. Its controls float, FRAMELESS, as individual round
// icon buttons (no group panel/board — that ate body width) at natural spots: page STATUS
// under the title, ACTIONS bottom-right, the VIM toggle bottom-left. Narrow screens
// (<768px) collapse the three into one bottom-right "⋯". Chrome only — every handler
// (publish flush, post-publish view, dirty guard, share/comments) is unchanged; this only
// relocates + restyles. Testids preserved so the existing e2e still applies. Desktop
// labels are hover tooltips (title=); the mobile ⋯ menu carries text labels.
export interface PageControlsProps {
  canEdit: boolean;
  // #490: the page's capability is not yet known (usePage still pending, e.g. mid-navigation). Distinct
  // from "confirmed view-only" (canEdit === false with the capability resolved): while pending, the
  // edit affordance must NOT be torn out and re-inserted (a flicker on every page switch), but it must
  // also not become an actionable edit button for a page that may resolve view-only. So the slot holds
  // an inert placeholder until the capability lands. Undefined on surfaces that always know (scratch).
  capabilityPending?: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  // #320 / ADR-126: the current page id — enables the watch (🔔) toggle in the view-mode actions. Undefined
  // (a scratch/preview surface with no real page) hides it.
  pageId?: string;
  // #362: the page's space — enables the space-scope watch item (emission scope only; server-gated).
  spaceId?: string;
  publishState?: "draft" | "unpublished" | null;
  canPublish?: boolean;
  onPublish?: () => void;
  publishing?: boolean;
  vim?: boolean;
  onToggleVim?: () => void;
  // ADR-056 / #164: editor display mode. Edit-only. The segmented selector switches DIRECTLY
  // (onSetDisplayMode); the keyboard shortcut cycles (onCycleDisplayMode, Ctrl+Alt+E). #165: the
  // current mode is always visible (segment highlight) so there is NO per-switch toast.
  displayMode?: "live" | "source" | "reading" | "wysiwyg";
  onCycleDisplayMode?: () => void;
  onSetDisplayMode?: (m: "live" | "source" | "reading" | "wysiwyg") => void;
  // #289 / ADR-115: per-user chrome visibility (member setting; guests get the full chrome).
  // showVimToggle=false hides the vim BUTTON only (Ctrl+Alt+V still works); visibleModes filters
  // the display-mode segment (the cycle key skips hidden modes at the hook level).
  showVimToggle?: boolean;
  // #406 S4 / ADR-159 (e): (pointer: coarse) forces vim OFF — soft-keyboard input breaks under vim.
  // The toggle stays VISIBLE but disabled with an explanatory tooltip; the stored keymap preference
  // is untouched (back on a fine-pointer device, vim returns).
  vimForcedOff?: boolean;
  visibleModes?: ("live" | "source" | "reading" | "wysiwyg")[];
  onShare?: () => void;
  commentsOpen?: boolean;
  onToggleComments?: () => void;
  openComments?: number;
  tocOpen?: boolean; // #192: table-of-contents rail toggle
  onToggleToc?: () => void;
  onHistory?: () => void;
  onAttachments?: () => void;
  onExport?: () => void;
  onExportHtml?: () => void; // #85: server-rendered, sanitized HTML export
  onPrint?: () => void;
  onPermissions?: () => void;
  // Delete the page. Set only when the caller may manage the page (FGA `manage`); the
  // server re-checks and 403s regardless (two-layer authz). Undefined → item hidden.
  onDelete?: () => void;
  // #437 / ADR-167: the direct permanent entry (modes both/direct_only) — separate from the trash
  // entry so the irreversible action never hides behind the reversible label.
  onDeleteForever?: () => void;
  onDuplicate?: () => void; // #229: create a new page seeded from this one (template)
  onSaveTemplate?: () => void; // #248: save this page's published content as a reusable template
  onRelated?: () => void; // #322 / ADR-133: open the "Related" right-rail panel (§Backlinks 1-hop + future 2-hop/graph/tags)
  onAnalytics?: () => void; // #464 / ADR-175: open the page-analytics right panel (manager-only; set only for managers)
  dirtySignal?: DirtySignal;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    m.addEventListener("change", on);
    setMatches(m.matches);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

// A single round, frameless, floating icon button (translucent surface + soft shadow so
// it reads over body text — but no group panel). Label is a hover tooltip (title/aria).
const ROUND = "pointer-events-auto inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground shadow-md backdrop-blur transition-colors duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] disabled:opacity-50 disabled:cursor-default";
const ROUND_BG = "bg-[color-mix(in_srgb,var(--panel)_82%,transparent)] hover:bg-panel-2";
const ROUND_PRIMARY = "bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--accent)_88%,black)]";

function RoundBtn({ label, icon, onClick, testId, primary, disabled, badge, active }: {
  label: string; icon: ReactNode; onClick?: () => void; testId: string; primary?: boolean; disabled?: boolean; badge?: ReactNode; active?: boolean;
}) {
  return (
    // #192: `active` (e.g. TOC rail ON) shows the accent fill so the toggle state reads at a glance,
    // matching the display-mode segment's active style.
    <button type="button" data-tip={label} aria-label={label} aria-pressed={active} data-testid={testId} data-active={active || undefined} disabled={disabled} onClick={onClick}
      className={`relative ${ROUND} ${active ? "bg-[var(--accent)] text-white" : primary ? ROUND_PRIMARY : ROUND_BG}`}>
      {icon}
      {badge}
    </button>
  );
}

// #368: the page watch is a ⋯-menu ITEM now (not a standalone round button). Its async watching state
// (react-query) is resolved by the caller and passed in so `overflowItems` — a plain builder, no hooks —
// can reflect it (Eye = watching / EyeOff = not) and flip it on select.
// #362 → #467 (owner ruling, ADR-126 addendum): ONE watch control. The subtree and space scope items
// are gone from the menu — three toggles for one concept read as clutter, and watching a whole subtree
// was never asked for in practice. The SERVER still speaks all three scopes, so existing subtree/space
// watches keep firing and stay listable/removable from /watches (no stranded rows, no migration).
export interface WatchItem { watching: boolean; toggle: () => void; disabled: boolean }
export interface WatchItems { page: WatchItem }

// Exported for the menu-composition pins (#207): a plain builder with no hooks, so a test can ask what
// the ⋯ menu offers without mounting the page.
export function overflowItems(p: PageControlsProps, t: (k: string) => string, watch?: WatchItems): OverflowItem[] {
  const items: OverflowItem[] = [];
  // #368: Watch lives in the ⋯ menu in VIEW mode (member-only; only for a real page). Eye = watching,
  // EyeOff = not — a toggle item (trailing ✓ when on). Icon is the EYE glyph per the ticket; the
  // notification-feed bell (NotificationBell) is a different control and is untouched.
  // #467: exactly ONE watch item — it reads "watch this page" or "unwatch", nothing else.
  if (!p.editing && p.pageId && watch) {
    items.push({ value: "watch", label: watch.page.watching ? t("watch.unwatch") : t("watch.watch"), icon: watch.page.watching ? <Eye size={14} /> : <EyeOff size={14} />, testId: "watch-toggle", checked: watch.page.watching, disabled: watch.page.disabled });
  }
  // #212: comments toggle lives here now (was an always-visible bar button). It's a right-panel toggle
  // exactly like history/attachments, so it shows NO ✓ open-state marker (comment 720): the three
  // right-panel items are visually identical and open/closed is read from the panel itself, not a tick.
  if (p.onToggleComments) items.push({ value: "comments", label: p.openComments ? `${t("page.comments")} (${p.openComments})` : t("page.comments"), icon: <MessageSquare size={14} />, testId: "comments-toggle" });
  if (p.onExport) items.push({ value: "export", label: t("page.export"), icon: <Download size={14} />, testId: "export-page" });
  // #85: the HTML export was GRAYED OUT because of three named defects in the static renderer — math
  // leaked as raw `$$`, table/callout/embed diverged from the screen, and the sheet came out dark. All
  // three are closed (KaTeX MathML on the static path, the prose/callout/todo convergence, and the
  // light-fixed export), the dynamic lists it used to drop now resolve, and a block that still cannot be
  // drawn statically says so. The item is live.
  if (p.onExportHtml) items.push({ value: "export-html", label: t("page.exportHtml"), icon: <Download size={14} />, testId: "export-page-html" });
  // #207: print was sealed for the same reason the HTML export above was — both printed a low-fidelity
  // document until the render core was rebuilt. It goes through that very export now (ADR-191: one
  // server-rendered document, math and checklists and callouts all static, no raw ::: leak), with a
  // three-surface parity gate keeping the screen and the page from drifting apart again. The item is live.
  if (p.onPrint) items.push({ value: "print", label: t("page.print"), icon: <Printer size={14} />, testId: "print-page" });
  if (p.onAttachments) items.push({ value: "attachments", label: t("page.attachments"), icon: <Paperclip size={14} />, testId: "attachments-toggle" });
  if (p.onHistory) items.push({ value: "history", label: t("page.history"), icon: <History size={14} />, testId: "history-toggle" });
  // #322 / ADR-133: "Related" — open the related right-rail panel (both modes; §Backlinks 1-hop today).
  if (p.onRelated) items.push({ value: "related", label: t("related.title"), icon: <LinkIcon size={14} />, testId: "related-toggle" });
  // #464 / ADR-175: "Who viewed this page" analytics — a manager-only right panel (set only for managers in routes).
  if (p.onAnalytics) items.push({ value: "analytics", label: t("pageAnalytics.title"), icon: <BarChart3 size={14} />, testId: "analytics-toggle" });
  if (p.onPermissions) items.push({ value: "permissions", label: t("page.permissions"), icon: <Shield size={14} />, testId: "permissions-open" });
  // Share in the ⋯ in BOTH modes. #368 removed the dedicated view-mode Share round button (it grew the
  // bottom-right cluster and pushed the always-present Edit button around), so view mode reaches Share here
  // too. manage-gated by onShare being set (the server re-checks). #4.
  if (p.onShare) items.push({ value: "share", label: t("page.share"), icon: <Share2 size={14} />, testId: "share-page" });
  // #229: use this page as a template — create a new page seeded with its content. Any viewer can
  // (the server view-gates the source); available in both modes.
  if (p.onDuplicate) items.push({ value: "duplicate", label: t("page.duplicatePage"), icon: <Copy size={14} />, testId: "duplicate-page" });
  // #248: save as a reusable template. Requires a published version (a template snapshots published_md),
  // so a draft-only page shows the item GRAYED OUT with a hint (discoverable, matches the #85 pattern).
  if (p.onSaveTemplate) items.push({ value: "save-template", label: t("template.saveAsTemplate"), icon: <FileStack size={14} />, testId: "save-template-open", disabled: p.publishState === "draft", hint: p.publishState === "draft" ? t("template.needsPublish") : undefined });
  // Delete in BOTH modes; manage-gated by onDelete being set. Destructive (danger). #4.
  if (p.onDelete) items.push({ value: "delete", label: t("page.delete"), icon: <Trash2 size={14} />, testId: "delete-page", danger: true });
  if (p.onDeleteForever) items.push({ value: "deleteForever", label: t("page.deleteForever"), icon: <Trash2 size={14} />, testId: "delete-page-forever", danger: true });
  return items;
}
function runOverflow(p: PageControlsProps, v: string, watch?: WatchItems) {
  if (v === "watch") { watch?.page.toggle(); return; }
  if (v === "duplicate") { p.onDuplicate?.(); return; }
  if (v === "save-template") { p.onSaveTemplate?.(); return; }
  if (v === "related") { p.onRelated?.(); return; }
  if (v === "analytics") { p.onAnalytics?.(); return; }
  if (v === "comments") p.onToggleComments?.();
  else if (v === "export") p.onExport?.();
  else if (v === "export-html") p.onExportHtml?.();
  else if (v === "print") p.onPrint?.();
  else if (v === "history") p.onHistory?.();
  else if (v === "attachments") p.onAttachments?.();
  else if (v === "permissions") p.onPermissions?.();
  else if (v === "share") p.onShare?.();
  else if (v === "delete") p.onDelete?.();
  else if (v === "deleteForever") p.onDeleteForever?.();
}

// ── STATUS: under the title, right-aligned (draft / unpublished text + comments btn) ──
export function PageStatus(p: PageControlsProps) {
  const { t } = useTranslation();
  if (!p.publishState && !p.onToggleToc) return null;
  return (
    <div className="pointer-events-auto flex items-center gap-2" data-testid="page-status">
      {p.publishState === "draft" && <span className="text-xs text-fg-dim" data-testid="draft-badge">{t("page.draft")}</span>}
      {p.publishState === "unpublished" && <span className="text-xs text-[var(--accent)]" data-testid="unpublished-badge">{t("page.unpublishedChanges")}</span>}
      {/* #212: TOC is a common ToggleButton (filled=ON + aria-pressed). Comments moved OUT of the
          always-visible bar into the ⋯ overflow (it's an occasional toggle, not a frequent one). */}
      {p.onToggleToc && (
        <ToggleButton
          pressed={!!p.tocOpen}
          onToggle={p.onToggleToc}
          icon={<List size={16} />}
          label={t("toc.toggle")}
          testId="toc-toggle"
        />
      )}
    </div>
  );
}

// ── VIM: bottom-left — a toggle SWITCH (#4). The official Vim logo is trademarked / not
// freely licensed, so we use a terminal glyph + "Vim" label + an on/off switch track
// (state reads at a glance). ──────────────────────────────────────────────────────────
export function PageVim(p: PageControlsProps) {
  const { t } = useTranslation();
  if (!p.editing || (!p.onToggleVim && !p.onCycleDisplayMode && !p.onSetDisplayMode)) return null;
  const dm = p.displayMode ?? "live";
  return (
    <div data-print-hide className="pointer-events-none absolute bottom-4 left-4 z-10 flex items-center gap-2">
      {/* #212: vim is the same common ToggleButton as TOC (filled=ON + aria-pressed), not a bespoke
          switch — state reads from the fill (a11y: not colour-only). Keeps the "Vim" text label. */}
      {p.onToggleVim && p.showVimToggle !== false && (
        <ToggleButton
          pressed={!!p.vim}
          onToggle={p.onToggleVim}
          icon={<SquareTerminal size={14} />}
          label={p.vimForcedOff ? t(p.displayMode === "wysiwyg" ? "page.vimWysiwygDisabled" : "page.vimTouchDisabled") : t("page.vimMode")}
          text="Vim"
          testId="vim-toggle"
          disabled={p.vimForcedOff}
        />
      )}
      {/* ADR-056 / #164 · #165: display-mode SEGMENT — icon-only buttons, current highlighted, one
          click switches DIRECTLY. The current mode is always visible (highlight) so there is NO
          per-switch toast. The Ctrl+Alt+E shortcut still CYCLES (onCycleDisplayMode). Toolbar-only —
          display-mode is display-only (never touches doc/offset/presence; reveal-on-cursor un-animated). */}
      {p.onSetDisplayMode && (
        <div role="radiogroup" aria-label={t("page.displayMode")} data-testid="displaymode-segment" data-mode={dm}
          className="pointer-events-auto inline-flex items-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--panel)_82%,transparent)] p-1 shadow-md backdrop-blur">
          {DISPLAY_MODES.filter(({ mode }) => !p.visibleModes || p.visibleModes.includes(mode)).map(({ mode, Icon, labelKey }) => {
            const active = dm === mode;
            return (
              <button key={mode} type="button" role="radio" aria-checked={active}
                data-testid={`displaymode-${mode}`} data-active={active}
                data-tip={t(labelKey)} aria-label={t(labelKey)} onClick={() => p.onSetDisplayMode!(mode)}
                className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors ${active ? "bg-[var(--accent)] text-white" : "text-fg-dim hover:bg-panel-2"}`}>
                <Icon size={14} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// #368: resolve the page's async watch state into a plain, serialisable WatchItem the ⋯-menu builder can
// consume. Hooks run unconditionally (react-query gates on pageId via `enabled`); returns undefined for a
// surface with no real page so no watch item is offered. Shared by desktop + mobile controls.
// #467: only the PAGE scope is offered, so only its state/toggle are subscribed — the subtree and
// space queries are gone (they cost a request each on every page open for a control nobody sees).
// #489 boot slice: the state is DEFERRED until the ⋯ menu actually opens (`active`) — it was one more
// request on every page open for a row nobody sees until they open the menu. Until the state loads the
// row stays disabled (isPending), so a fast click cannot toggle in the wrong direction.
function useWatchItem(pageId: string | undefined, active: boolean): WatchItems | undefined {
  const pageState = useWatchState(active ? pageId : undefined, "page");
  const pageToggle = useToggleWatch(pageId, "page");
  if (!pageId) return undefined;
  return {
    page: {
      watching: pageState.data?.watching ?? false,
      toggle: () => pageToggle.mutate(pageState.data),
      disabled: pageToggle.isPending || pageState.isPending,
    },
  };
}

// ── ACTIONS: bottom-right — round icon buttons (edit/done/publish + ⋯) ─────────────────
export function PageActions(p: PageControlsProps) {
  const { t } = useTranslation();
  const dirty = useDirty(p.dirtySignal);
  const canPublish = p.canPublish || dirty;
  const [menuOpen, setMenuOpen] = useState(false); // #489: fetch watch state on menu open, not page open
  const watch = useWatchItem(p.pageId, menuOpen);
  const overflow = overflowItems(p, t, watch);
  return (
    // Outer stays click-through (pointer-events-none) so the empty bottom-right area doesn't eat editor clicks;
    // the inner cluster is pointer-events-auto. #368: the view-mode cluster is a FIXED [Edit][⋯] (edit never
    // moves) — Watch + Share moved INTO the ⋯ menu (the earlier slide-out grew the cluster and shoved the
    // always-present Edit button around, and hovering to reach Edit tripped the reveal).
    <div data-print-hide className="pointer-events-none absolute right-4 bottom-4 z-10 flex items-center">
      <div className="pointer-events-auto flex items-center gap-2">
        {p.editing ? (
          <>
            {p.onPublish && (
              <RoundBtn label={t("page.publish")} testId="publish-page" primary disabled={p.publishing || !canPublish} onClick={p.onPublish}
                icon={p.publishing ? <span data-testid="publish-spinner"><UploadCloud size={16} className="animate-pulse" /></span> : <UploadCloud size={16} />} />
            )}
            {/* Done = close the edit surface → X (not a check) reads as "close". */}
            <RoundBtn label={t("page.done")} testId="view-toggle" onClick={p.onDone} icon={<X size={16} />} />
          </>
        ) : (
          p.capabilityPending
            // #490: reserve the slot with an inert control so the row does not jump between page loads;
            // it is not clickable, so a page that resolves view-only never exposed an edit action.
            ? <RoundBtn label={t("page.edit")} testId="edit-toggle-pending" disabled onClick={undefined} icon={<Pencil size={16} />} />
            : p.canEdit && <RoundBtn label={t("page.edit")} testId="edit-toggle" primary onClick={p.onEdit} icon={<Pencil size={16} />} />
        )}
        {overflow.length > 0 && (
          <OverflowMenu items={overflow} onSelect={(v) => runOverflow(p, v, watch)} label={t("page.moreActions")} triggerClassName={`${ROUND} ${ROUND_BG}`} onOpenChange={setMenuOpen} />
        )}
      </div>
    </div>
  );
}

// ── MOBILE: one "⋯" bottom-right opening everything (text labels in the menu) ─────────
export function PageControlsMobile(p: PageControlsProps) {
  const { t } = useTranslation();
  const dirty = useDirty(p.dirtySignal);
  const canPublish = p.canPublish || dirty;
  const [menuOpen, setMenuOpen] = useState(false); // #489: fetch watch state on menu open, not page open
  const watch = useWatchItem(p.pageId, menuOpen);
  const overflow = overflowItems(p, t, watch);
  return (
    <div data-print-hide className="absolute right-4 bottom-4 z-10">
      <DropdownMenu modal={false} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <IconButton aria-label={t("page.moreActions")} data-tip={t("page.moreActions")} data-testid="page-controls-mobile" className={`${ROUND} ${ROUND_BG}`}>
            <MoreHorizontal size={18} />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" data-testid="page-controls-mobile-menu">
          {p.publishState && (
            <DropdownMenuLabel className={p.publishState === "unpublished" ? "text-[var(--accent)]" : "text-fg-dim"}>
              {t(p.publishState === "draft" ? "page.draft" : "page.unpublishedChanges")}
            </DropdownMenuLabel>
          )}
          {p.editing ? (
            <>
              {p.onPublish && <DropdownMenuItem disabled={p.publishing || !canPublish} onSelect={() => p.onPublish?.()} data-testid="m-publish-page"><UploadCloud size={14} /> {t("page.publish")}</DropdownMenuItem>}
              <DropdownMenuItem onSelect={p.onDone} data-testid="m-view-toggle"><X size={14} /> {t("page.done")}</DropdownMenuItem>
              {p.onToggleVim && p.showVimToggle !== false && <DropdownMenuItem disabled={p.vimForcedOff} onSelect={p.onToggleVim} data-testid="m-vim-toggle"><SquareTerminal size={14} /> Vim {p.vimForcedOff ? t("common.off") : p.vim ? t("common.on") : t("common.off")}</DropdownMenuItem>}
              {/* #507: a submenu that lists the modes for DIRECT selection — the old single item CYCLED
                  on every tap and closed the menu, so reaching a mode took up to three open-tap-close
                  rounds. Same direct-selection idea as the desktop segment (ADR-056 / #164); the
                  Ctrl+Alt+E cycle shortcut is untouched. */}
              {p.onSetDisplayMode && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="m-displaymode-toggle">
                    {(() => {
                      const cur = DISPLAY_MODES.find((m) => m.mode === (p.displayMode ?? "live")) ?? DISPLAY_MODES[0]!;
                      const CurIcon = cur.Icon;
                      return <><CurIcon size={14} /> {t("page.displayMode")}: {t(cur.labelKey)}</>;
                    })()}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent data-testid="m-displaymode-menu">
                    {DISPLAY_MODES.filter(({ mode }) => !p.visibleModes || p.visibleModes.includes(mode)).map(({ mode, Icon, labelKey }) => (
                      <DropdownMenuItem key={mode} onSelect={() => p.onSetDisplayMode!(mode)} data-testid={`m-displaymode-${mode}`}>
                        <Icon size={14} /> {t(labelKey)}
                        {(p.displayMode ?? "live") === mode && <Check size={14} className="ml-auto text-[var(--accent)]" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
            </>
          ) : (
            // #368: view mode = just Edit here; Watch + Share are in the overflow section below (built by
            // overflowItems, so desktop and mobile stay in sync — no duplicate Share).
            p.capabilityPending
              ? <DropdownMenuItem disabled data-testid="m-edit-toggle-pending"><Pencil size={14} /> {t("page.edit")}</DropdownMenuItem>
              : p.canEdit && <DropdownMenuItem onSelect={p.onEdit} data-testid="m-edit-toggle"><Pencil size={14} /> {t("page.edit")}</DropdownMenuItem>
          )}
          {/* #212: comments is part of overflowItems now (rendered below), so no separate entry here. */}
          {overflow.length > 0 && <DropdownMenuSeparator />}
          {overflow.map((it) => (
            <DropdownMenuItem key={it.value} disabled={it.disabled} onSelect={() => runOverflow(p, it.value, watch)} data-testid={`m-${it.testId}`}>{it.icon} {it.label}{it.checked && <Check size={14} className="ml-auto text-[var(--accent)]" />}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
