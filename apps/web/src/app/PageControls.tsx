import { useEffect, useState } from "react";
import { Pencil, Share2, MessageSquare, History, Download, Printer, Shield, SquareTerminal, Check, Loader2, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "../ui/Button";
import { OverflowMenu, type OverflowItem } from "../ui/OverflowMenu";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel } from "../components/ui/dropdown-menu";
import { useDirty, type DirtySignal } from "../editor/dirtySignal";

// The old full-width top bar is gone. Its controls float, frameless, in role-based
// groups placed at natural spots (ADR — Group C chrome): page STATUS under the title,
// ACTIONS bottom-right, the VIM toggle bottom-left. On a narrow screen the three groups
// collapse into a single bottom-right "⋯". Chrome only — every handler/behaviour
// (publish flush, post-publish view, dirty guard, share/comments) is unchanged; this
// only relocates the controls. Testids are preserved so the existing e2e still applies.
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
  onShare?: () => void;
  commentsOpen?: boolean;
  onToggleComments?: () => void;
  openComments?: number;
  onHistory?: () => void;
  onExport?: () => void;
  onPrint?: () => void;
  onPermissions?: () => void;
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

// Frameless floating cluster: translucent, soft shadow, no border — .
const cluster = "pointer-events-auto flex items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--panel)_85%,transparent)] px-1.5 py-1 shadow-md backdrop-blur";

function overflowItems(p: PageControlsProps, t: (k: string) => string): OverflowItem[] {
  const items: OverflowItem[] = [];
  if (p.onExport) items.push({ value: "export", label: t("page.export"), icon: <Download size={14} />, testId: "export-page" });
  if (p.onPrint) items.push({ value: "print", label: t("page.print"), icon: <Printer size={14} />, testId: "print-page" });
  if (p.onHistory) items.push({ value: "history", label: t("page.history"), icon: <History size={14} />, testId: "history-toggle" });
  if (p.onPermissions) items.push({ value: "permissions", label: t("page.permissions"), icon: <Shield size={14} />, testId: "permissions-open" });
  return items;
}
function runOverflow(p: PageControlsProps, v: string) {
  if (v === "export") p.onExport?.();
  else if (v === "print") p.onPrint?.();
  else if (v === "history") p.onHistory?.();
  else if (v === "permissions") p.onPermissions?.();
}

// ── STATUS: under the title, right-aligned (draft / unpublished / comments) ──────────
export function PageStatus(p: PageControlsProps) {
  const { t } = useTranslation();
  if (!p.publishState && !p.onToggleComments) return null;
  return (
    <div className="pointer-events-auto flex items-center gap-2" data-testid="page-status">
      {p.publishState === "draft" && <span className="rounded-full px-2 py-px text-xs text-fg-dim" data-testid="draft-badge">{t("page.draft")}</span>}
      {p.publishState === "unpublished" && <span className="rounded-full px-2 py-px text-xs text-[var(--accent)]" data-testid="unpublished-badge">{t("page.unpublishedChanges")}</span>}
      {p.onToggleComments && (
        <IconButton aria-label={t("page.comments")} data-testid="comments-toggle" aria-pressed={p.commentsOpen} onClick={p.onToggleComments}>
          <MessageSquare size={15} />{p.openComments ? <span className="ml-0.5 text-[11px] text-fg-dim">{p.openComments}</span> : null}
        </IconButton>
      )}
    </div>
  );
}

// ── VIM: bottom-left of the editor area ─────────────────────────────────────────────
export function PageVim(p: PageControlsProps) {
  const { t } = useTranslation();
  if (!p.editing || !p.onToggleVim) return null;
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-10">
      <div className={cluster}>
        <Button size="sm" variant={p.vim ? "primary" : "ghost"} data-testid="vim-toggle" role="switch" aria-checked={p.vim} aria-label={t("page.vimMode")} title={t("page.vimMode")} onClick={p.onToggleVim}>
          <SquareTerminal size={14} /> Vim {p.vim ? t("common.on") : t("common.off")}
        </Button>
      </div>
    </div>
  );
}

// ── ACTIONS: bottom-right of the editor area (edit/done/publish/share + ⋯) ───────────
export function PageActions(p: PageControlsProps) {
  const { t } = useTranslation();
  const dirty = useDirty(p.dirtySignal);
  const canPublish = p.canPublish || dirty;
  const overflow = overflowItems(p, t);
  return (
    <div className="pointer-events-none absolute right-4 bottom-4 z-10">
      <div className={cluster}>
        {p.editing ? (
          <>
            {p.onPublish && (
              <Button size="sm" variant="primary" data-testid="publish-page" disabled={p.publishing || !canPublish} onClick={p.onPublish}>
                {p.publishing ? <Loader2 size={14} className="animate-spin" data-testid="publish-spinner" /> : null}
                {t("page.publish")}
              </Button>
            )}
            <Button size="sm" data-testid="view-toggle" onClick={p.onDone}><Check size={14} /> {t("page.done")}</Button>
          </>
        ) : (
          <>
            {p.canEdit && <Button size="sm" data-testid="edit-toggle" onClick={p.onEdit}><Pencil size={14} /> {t("page.edit")}</Button>}
            {p.onShare && <Button size="sm" variant="ghost" data-testid="share-open" onClick={p.onShare}><Share2 size={14} /> {t("page.share")}</Button>}
          </>
        )}
        {overflow.length > 0 && <OverflowMenu items={overflow} onSelect={(v) => runOverflow(p, v)} label={t("page.moreActions")} />}
      </div>
    </div>
  );
}

// ── MOBILE: one "⋯" bottom-right that opens everything in a menu ─────────────────────
export function PageControlsMobile(p: PageControlsProps) {
  const { t } = useTranslation();
  const dirty = useDirty(p.dirtySignal);
  const canPublish = p.canPublish || dirty;
  const overflow = overflowItems(p, t);
  return (
    <div className="absolute right-4 bottom-4 z-10">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <IconButton aria-label={t("page.moreActions")} title={t("page.moreActions")} data-testid="page-controls-mobile" className={cluster}>
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
              {p.onPublish && <DropdownMenuItem disabled={p.publishing || !canPublish} onSelect={() => p.onPublish?.()} data-testid="m-publish-page">{t("page.publish")}</DropdownMenuItem>}
              <DropdownMenuItem onSelect={p.onDone} data-testid="m-view-toggle"><Check size={14} /> {t("page.done")}</DropdownMenuItem>
              {p.onToggleVim && <DropdownMenuItem onSelect={p.onToggleVim} data-testid="m-vim-toggle"><SquareTerminal size={14} /> Vim {p.vim ? t("common.on") : t("common.off")}</DropdownMenuItem>}
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
