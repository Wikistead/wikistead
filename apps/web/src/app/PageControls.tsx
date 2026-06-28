import { useEffect, useState, type ReactNode } from "react";
import { Pencil, Share2, MessageSquare, History, Download, Printer, Shield, SquareTerminal, X, UploadCloud, MoreHorizontal, Paperclip, Trash2, Eye, Code, BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../ui/Button";
import { OverflowMenu, type OverflowItem } from "../ui/OverflowMenu";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel } from "../components/ui/dropdown-menu";
import { useDirty, type DirtySignal } from "../editor/dirtySignal";

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
  // ADR-056 / #164: editor display mode + cycle (live ⇄ source in phase 1). Edit-only.
  displayMode?: "live" | "source" | "reading" | "wysiwyg";
  onCycleDisplayMode?: () => void;
  onShare?: () => void;
  commentsOpen?: boolean;
  onToggleComments?: () => void;
  openComments?: number;
  onHistory?: () => void;
  onAttachments?: () => void;
  onExport?: () => void;
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

function RoundBtn({ label, icon, onClick, testId, primary, disabled, badge }: {
  label: string; icon: ReactNode; onClick?: () => void; testId: string; primary?: boolean; disabled?: boolean; badge?: ReactNode;
}) {
  return (
    <button type="button" title={label} aria-label={label} data-testid={testId} disabled={disabled} onClick={onClick}
      className={`relative ${ROUND} ${primary ? ROUND_PRIMARY : ROUND_BG}`}>
      {icon}
      {badge}
    </button>
  );
}

function overflowItems(p: PageControlsProps, t: (k: string) => string): OverflowItem[] {
  const items: OverflowItem[] = [];
  if (p.onExport) items.push({ value: "export", label: t("page.export"), icon: <Download size={14} />, testId: "export-page" });
  if (p.onPrint) items.push({ value: "print", label: t("page.print"), icon: <Printer size={14} />, testId: "print-page" });
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
  if (v === "export") p.onExport?.();
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
  if (!p.publishState && !p.onToggleComments) return null;
  return (
    <div className="pointer-events-auto flex items-center gap-2" data-testid="page-status">
      {p.publishState === "draft" && <span className="text-xs text-fg-dim" data-testid="draft-badge">{t("page.draft")}</span>}
      {p.publishState === "unpublished" && <span className="text-xs text-[var(--accent)]" data-testid="unpublished-badge">{t("page.unpublishedChanges")}</span>}
      {p.onToggleComments && (
        <RoundBtn
          label={t("page.comments")}
          testId="comments-toggle"
          onClick={p.onToggleComments}
          icon={<MessageSquare size={16} />}
          badge={p.openComments ? <span className="absolute -top-0.5 -right-0.5 min-w-[15px] rounded-full bg-[var(--accent)] px-1 text-[10px] leading-[15px] text-primary-foreground">{p.openComments}</span> : null}
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
  if (!p.editing || (!p.onToggleVim && !p.onCycleDisplayMode)) return null;
  const dm = p.displayMode ?? "live";
  const modeIcon = dm === "source" ? <Code size={14} className="text-[var(--accent)]" />
    : dm === "reading" ? <BookOpen size={14} className="text-[var(--accent)]" />
    : <Eye size={14} className="text-fg-dim" />;
  const modeLabel = t(dm === "source" ? "page.modeSource" : dm === "reading" ? "page.modeReading" : "page.modeLive");
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex items-center gap-2">
      {p.onToggleVim && (
        <button type="button" role="switch" aria-checked={p.vim} data-testid="vim-toggle"
          title={t("page.vimMode")} aria-label={t("page.vimMode")} onClick={p.onToggleVim}
          className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--panel)_82%,transparent)] px-3 py-1.5 text-xs font-medium shadow-md backdrop-blur transition-colors hover:bg-panel-2">
          <SquareTerminal size={14} className={p.vim ? "text-[var(--accent)]" : "text-fg-dim"} />
          <span>Vim</span>
          <span className={`relative inline-block h-4 w-7 rounded-full transition-colors ${p.vim ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}>
            <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${p.vim ? "left-[14px]" : "left-0.5"}`} />
          </span>
        </button>
      )}
      {/* ADR-056 / #164: display-mode toggle (live ⇄ source). A pill that shows + cycles the mode. */}
      {p.onCycleDisplayMode && (
        <button type="button" data-testid="displaymode-toggle" data-mode={dm}
          title={t("page.displayMode")} aria-label={t("page.displayMode")} onClick={p.onCycleDisplayMode}
          className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--panel)_82%,transparent)] px-3 py-1.5 text-xs font-medium shadow-md backdrop-blur transition-colors hover:bg-panel-2">
          {modeIcon}
          <span>{modeLabel}</span>
        </button>
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
              {p.onCycleDisplayMode && <DropdownMenuItem onSelect={p.onCycleDisplayMode} data-testid="m-displaymode-toggle">{p.displayMode === "source" ? <Code size={14} /> : p.displayMode === "reading" ? <BookOpen size={14} /> : <Eye size={14} />} {t("page.displayMode")}: {t(p.displayMode === "source" ? "page.modeSource" : p.displayMode === "reading" ? "page.modeReading" : "page.modeLive")}</DropdownMenuItem>}
            </>
          ) : (
            <>
              {p.canEdit && <DropdownMenuItem onSelect={p.onEdit} data-testid="m-edit-toggle"><Pencil size={14} /> {t("page.edit")}</DropdownMenuItem>}
              {p.onShare && <DropdownMenuItem onSelect={p.onShare} data-testid="m-share-open"><Share2 size={14} /> {t("page.share")}</DropdownMenuItem>}
            </>
          )}
          {p.onToggleComments && <DropdownMenuItem onSelect={p.onToggleComments} data-testid="m-comments-toggle"><MessageSquare size={14} /> {t("page.comments")}{p.openComments ? ` (${p.openComments})` : ""}</DropdownMenuItem>}
          {overflow.length > 0 && <DropdownMenuSeparator />}
          {overflow.map((it) => (
            <DropdownMenuItem key={it.value} onSelect={() => runOverflow(p, it.value)} data-testid={`m-${it.testId}`}>{it.icon} {it.label}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
