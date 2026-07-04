import { useEffect, useState, type ReactNode } from "react";
import { Pencil, Share2, MessageSquare, History, Download, Printer, Shield, SquareTerminal, X, UploadCloud, MoreHorizontal, Paperclip, Trash2, Eye, Code, BookOpen, Sparkles, List } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../ui/Button";
import { ToggleButton } from "../ui/ToggleButton";
import { OverflowMenu, type OverflowItem } from "../ui/OverflowMenu";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel } from "../components/ui/dropdown-menu";
import { useDirty, type DirtySignal } from "../editor/dirtySignal";

// #165 display-mode segment: icon-only entries, in cycle order (matches Ctrl+Alt+E). Icons mirror the
// per-mode glyphs used elsewhere (Live=Eye, Source=Code, Reading=BookOpen, WYSIWYG=Sparkles).
const DISPLAY_MODES = [
  { mode: "live" as const, Icon: Eye, labelKey: "page.modeLive" },
  { mode: "source" as const, Icon: Code, labelKey: "page.modeSource" },
  { mode: "reading" as const, Icon: BookOpen, labelKey: "page.modeReading" },
  { mode: "wysiwyg" as const, Icon: Sparkles, labelKey: "page.modeWysiwyg" },
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
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
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
    <button type="button" title={label} aria-label={label} aria-pressed={active} data-testid={testId} data-active={active || undefined} disabled={disabled} onClick={onClick}
      className={`relative ${ROUND} ${active ? "bg-[var(--accent)] text-white" : primary ? ROUND_PRIMARY : ROUND_BG}`}>
      {icon}
      {badge}
    </button>
  );
}

function overflowItems(p: PageControlsProps, t: (k: string) => string): OverflowItem[] {
  const items: OverflowItem[] = [];
  // #212: comments toggle lives here now (was an always-visible bar button). It's a right-panel toggle
  // exactly like history/attachments, so it shows NO ✓ open-state marker (comment 720): the three
  // right-panel items are visually identical and open/closed is read from the panel itself, not a tick.
  if (p.onToggleComments) items.push({ value: "comments", label: p.openComments ? `${t("page.comments")} (${p.openComments})` : t("page.comments"), icon: <MessageSquare size={14} />, testId: "comments-toggle" });
  if (p.onExport) items.push({ value: "export", label: t("page.export"), icon: <Download size={14} />, testId: "export-page" });
  // #85 bounce: the HTML export is sealed until the post-launch Option-A redesign — show the item but
  // GRAYED OUT (disabled) with a hint, rather than hiding it (per the user), so its return is discoverable.
  if (p.onExportHtml) items.push({ value: "export-html", label: t("page.exportHtml"), icon: <Download size={14} />, testId: "export-page-html", disabled: true, hint: t("page.exportHtmlDisabled") });
  // #207 bounce: print is sealed (same root as #85 — both print paths are low-fidelity until the
  // post-launch Option-A render core). Grayed out with a hint rather than hidden (matches #85).
  if (p.onPrint) items.push({ value: "print", label: t("page.print"), icon: <Printer size={14} />, testId: "print-page", disabled: true, hint: t("page.printDisabled") });
  if (p.onAttachments) items.push({ value: "attachments", label: t("page.attachments"), icon: <Paperclip size={14} />, testId: "attachments-toggle" });
  if (p.onHistory) items.push({ value: "history", label: t("page.history"), icon: <History size={14} />, testId: "history-toggle" });
  if (p.onPermissions) items.push({ value: "permissions", label: t("page.permissions"), icon: <Shield size={14} />, testId: "permissions-open" });
  // Share in the ⋯ only while EDITING (view mode already has the dedicated Share button).
  // manage-gated by onShare being set (the server re-checks). #4.
  if (p.editing && p.onShare) items.push({ value: "share", label: t("page.share"), icon: <Share2 size={14} />, testId: "share-page" });
  // Delete in BOTH modes; manage-gated by onDelete being set. Destructive (danger). #4.
  if (p.onDelete) items.push({ value: "delete", label: t("page.delete"), icon: <Trash2 size={14} />, testId: "delete-page", danger: true });
  return items;
}
function runOverflow(p: PageControlsProps, v: string) {
  if (v === "comments") p.onToggleComments?.();
  else if (v === "export") p.onExport?.();
  else if (v === "export-html") p.onExportHtml?.();
  else if (v === "print") p.onPrint?.();
  else if (v === "history") p.onHistory?.();
  else if (v === "attachments") p.onAttachments?.();
  else if (v === "permissions") p.onPermissions?.();
  else if (v === "share") p.onShare?.();
  else if (v === "delete") p.onDelete?.();
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
    <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex items-center gap-2">
      {/* #212: vim is the same common ToggleButton as TOC (filled=ON + aria-pressed), not a bespoke
          switch — state reads from the fill (a11y: not colour-only). Keeps the "Vim" text label. */}
      {p.onToggleVim && (
        <ToggleButton
          pressed={!!p.vim}
          onToggle={p.onToggleVim}
          icon={<SquareTerminal size={14} />}
          label={t("page.vimMode")}
          text="Vim"
          testId="vim-toggle"
        />
      )}
      {/* ADR-056 / #164 · #165: display-mode SEGMENT — icon-only buttons, current highlighted, one
          click switches DIRECTLY. The current mode is always visible (highlight) so there is NO
          per-switch toast. The Ctrl+Alt+E shortcut still CYCLES (onCycleDisplayMode). Toolbar-only —
          display-mode is display-only (never touches doc/offset/presence; reveal-on-cursor un-animated). */}
      {p.onSetDisplayMode && (
        <div role="radiogroup" aria-label={t("page.displayMode")} data-testid="displaymode-segment" data-mode={dm}
          className="pointer-events-auto inline-flex items-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--panel)_82%,transparent)] p-1 shadow-md backdrop-blur">
          {DISPLAY_MODES.map(({ mode, Icon, labelKey }) => {
            const active = dm === mode;
            return (
              <button key={mode} type="button" role="radio" aria-checked={active}
                data-testid={`displaymode-${mode}`} data-active={active}
                title={t(labelKey)} aria-label={t(labelKey)} onClick={() => p.onSetDisplayMode!(mode)}
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

// ── ACTIONS: bottom-right — round icon buttons (edit/done/publish/share + ⋯) ──────────
export function PageActions(p: PageControlsProps) {
  const { t } = useTranslation();
  const dirty = useDirty(p.dirtySignal);
  const canPublish = p.canPublish || dirty;
  const overflow = overflowItems(p, t);
  return (
    <div className="pointer-events-none absolute right-4 bottom-4 z-10 flex items-center gap-2">
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
        <>
          {p.canEdit && <RoundBtn label={t("page.edit")} testId="edit-toggle" primary onClick={p.onEdit} icon={<Pencil size={16} />} />}
          {p.onShare && <RoundBtn label={t("page.share")} testId="share-open" onClick={p.onShare} icon={<Share2 size={16} />} />}
        </>
      )}
      {overflow.length > 0 && (
        <OverflowMenu items={overflow} onSelect={(v) => runOverflow(p, v)} label={t("page.moreActions")} triggerClassName={`${ROUND} ${ROUND_BG}`} />
      )}
    </div>
  );
}

// ── MOBILE: one "⋯" bottom-right opening everything (text labels in the menu) ─────────
export function PageControlsMobile(p: PageControlsProps) {
  const { t } = useTranslation();
  const dirty = useDirty(p.dirtySignal);
  const canPublish = p.canPublish || dirty;
  const overflow = overflowItems(p, t);
  return (
    <div className="absolute right-4 bottom-4 z-10">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <IconButton aria-label={t("page.moreActions")} title={t("page.moreActions")} data-testid="page-controls-mobile" className={`${ROUND} ${ROUND_BG}`}>
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
              {p.onToggleVim && <DropdownMenuItem onSelect={p.onToggleVim} data-testid="m-vim-toggle"><SquareTerminal size={14} /> Vim {p.vim ? t("common.on") : t("common.off")}</DropdownMenuItem>}
              {p.onCycleDisplayMode && <DropdownMenuItem onSelect={p.onCycleDisplayMode} data-testid="m-displaymode-toggle">{p.displayMode === "source" ? <Code size={14} /> : p.displayMode === "reading" ? <BookOpen size={14} /> : p.displayMode === "wysiwyg" ? <Sparkles size={14} /> : <Eye size={14} />} {t("page.displayMode")}: {t(p.displayMode === "source" ? "page.modeSource" : p.displayMode === "reading" ? "page.modeReading" : p.displayMode === "wysiwyg" ? "page.modeWysiwyg" : "page.modeLive")}</DropdownMenuItem>}
            </>
          ) : (
            <>
              {p.canEdit && <DropdownMenuItem onSelect={p.onEdit} data-testid="m-edit-toggle"><Pencil size={14} /> {t("page.edit")}</DropdownMenuItem>}
              {p.onShare && <DropdownMenuItem onSelect={p.onShare} data-testid="m-share-open"><Share2 size={14} /> {t("page.share")}</DropdownMenuItem>}
            </>
          )}
          {/* #212: comments is part of overflowItems now (rendered below), so no separate entry here. */}
          {overflow.length > 0 && <DropdownMenuSeparator />}
          {overflow.map((it) => (
            <DropdownMenuItem key={it.value} onSelect={() => runOverflow(p, it.value)} data-testid={`m-${it.testId}`}>{it.icon} {it.label}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
