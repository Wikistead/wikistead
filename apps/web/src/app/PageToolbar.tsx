import { Pencil, Share2, MessageSquare, History, Download, Printer, Shield, SquareTerminal, Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "../ui/Button";
import { OverflowMenu, type OverflowItem } from "../ui/OverflowMenu";
import { useDirty, type DirtySignal } from "../editor/dirtySignal";

// The page title is a large heading at the top of the reading column (PageTitle.tsx);
// this thin top bar carries only the publish chips + actions.
//
// Mode-aware (driven by `editing`). READ = Edit/Share/Comments + ••• (Export/Print/
// History/Permissions). EDIT = Vim toggle/Publish/Done. Each control renders only when
// its handler/capability is provided, so the same component serves the member page and
// the guest share page. Authz gating is the caller's; the server stays the fortress.
export interface PageToolbarProps {
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  // publish
  publishState?: "draft" | "unpublished" | null; // chip shown in read mode
  canPublish?: boolean;
  onPublish?: () => void;
  publishing?: boolean;
  // edit-mode: vim keymap toggle (the single-view replacement for the split toggle)
  vim?: boolean;
  onToggleVim?: () => void;
  // read-mode actions (only those provided are shown)
  onShare?: () => void;
  commentsOpen?: boolean;
  onToggleComments?: () => void;
  openComments?: number;
  onHistory?: () => void;
  onExport?: () => void;
  onPrint?: () => void;
  onPermissions?: () => void; // implies canManage (caller gates)
  // Optimistic "unpublished changes" signal: enables Publish the instant an edit
  // diverges, without re-rendering the editor. ORed with canPublish (server poll).
  dirtySignal?: DirtySignal;
}

export function PageToolbar(p: PageToolbarProps) {
  const { t } = useTranslation();
  // Optimistic dirty (instant on edit) ORed with the server-poll canPublish. Only
  // this toolbar re-renders on the signal — the editor is a sibling, untouched.
  const dirty = useDirty(p.dirtySignal);
  const canPublish = p.canPublish || dirty;
  const overflow: OverflowItem[] = [];
  if (p.onExport) overflow.push({ value: "export", label: t("page.export"), icon: <Download size={14} />, testId: "export-page" });
  if (p.onPrint) overflow.push({ value: "print", label: t("page.print"), icon: <Printer size={14} />, testId: "print-page" });
  if (p.onHistory) overflow.push({ value: "history", label: t("page.history"), icon: <History size={14} />, testId: "history-toggle" });
  if (p.onPermissions) overflow.push({ value: "permissions", label: t("page.permissions"), icon: <Shield size={14} />, testId: "permissions-open" });
  const onOverflow = (v: string) => {
    if (v === "export") p.onExport?.();
    else if (v === "print") p.onPrint?.();
    else if (v === "history") p.onHistory?.();
    else if (v === "permissions") p.onPermissions?.();
  };

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-1" data-testid="page-toolbar">
      {p.publishState === "draft" && <span className="rounded-full border border-border px-2 py-px text-xs text-fg-dim" data-testid="draft-badge">{t("page.draft")}</span>}
      {p.publishState === "unpublished" && <span className="rounded-full border border-[color-mix(in_srgb,var(--accent)_50%,var(--border))] px-2 py-px text-xs text-[var(--accent)]" data-testid="unpublished-badge">{t("page.unpublishedChanges")}</span>}
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        {/* Comments is useful in both modes (read + while editing). */}
        {p.onToggleComments && (
          <IconButton aria-label={t("page.comments")} data-testid="comments-toggle" aria-pressed={p.commentsOpen} onClick={p.onToggleComments}>
            <MessageSquare size={15} />{p.openComments ? <span className="ml-0.5 text-[11px] text-fg-dim">{p.openComments}</span> : null}
          </IconButton>
        )}
        {p.editing ? (
          <>
            {p.onToggleVim && (
              <Button size="sm" variant="ghost" data-testid="vim-toggle" aria-pressed={p.vim} title={t("page.vimMode")} onClick={p.onToggleVim}>
                <SquareTerminal size={14} /> Vim
              </Button>
            )}
            {p.onPublish && (
              // While publishing, the server flushes the live draft, then publishes —
              // a real save+publish round-trip. Show a spinner and keep the button
              // disabled (also prevents a double publish; the server no-op guard is
              // the idempotency backstop).
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
        {/* Secondary actions are one click away in both modes. */}
        {overflow.length > 0 && <OverflowMenu items={overflow} onSelect={onOverflow} label={t("page.moreActions")} />}
      </div>
    </div>
  );
}
