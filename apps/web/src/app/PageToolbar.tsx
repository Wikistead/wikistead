import { useEffect, useState } from "react";
import { Pencil, Share2, MessageSquare, History, Download, Printer, Shield, Columns2, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "../ui/Button";
import { OverflowMenu, type OverflowItem } from "../ui/OverflowMenu";
import type { EditorLayout } from "../editor/Editor";
import { useDirty, type DirtySignal } from "../editor/dirtySignal";
import styles from "./PageToolbar.module.css";

// Inline-editable page title (Phase 5 #6). Click to rename (Notion/Outline style);
// shown editable only to edit-capable users — the server re-checks page#edit on the
// PATCH regardless. Enter/blur commits (if changed & non-empty), Escape cancels.
function EditableTitle({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  useEffect(() => { if (!editing) setDraft(title); }, [title, editing]);
  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== title) onRename(next);
  };
  if (editing) {
    return (
      <input
        className={styles.titleInput}
        data-testid="page-title-input"
        autoFocus
        value={draft}
        aria-label={t("dialogs.renamePageTitle")}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { setDraft(title); setEditing(false); }
        }}
        onBlur={commit}
      />
    );
  }
  return (
    <button type="button" className={styles.titleBtn} data-testid="page-title" title={t("dialogs.renamePageTitle")}
      onClick={() => { setDraft(title); setEditing(true); }}>
      {title || t("common.untitled")}
    </button>
  );
}

// Mode-aware page top bar (Phase 3b-3). One component for members AND guests, driven
// by `editing`. READ mode = title + Edit/Share/Comments + ••• (Export/Print/History/
// Permissions). EDIT mode = title + layout(split)/Publish/Done. Secondary actions are
// folded into ••• to keep the bar minimal (IA). Each control is rendered only when its
// handler/capability is provided, so the same component serves the member page (all
// actions) and the guest share page (edit/publish only). Authz gating is the caller's
// (canEdit/canManage/canPublish) — the server stays the fortress.
export interface PageToolbarProps {
  title: string;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  // publish
  publishState?: "draft" | "unpublished" | null; // chip shown in read mode
  canPublish?: boolean;
  onPublish?: () => void;
  publishing?: boolean;
  // edit-mode layout
  layout?: EditorLayout;
  onToggleLayout?: () => void;
  // read-mode actions (only those provided are shown)
  onShare?: () => void;
  commentsOpen?: boolean;
  onToggleComments?: () => void;
  openComments?: number;
  onHistory?: () => void;
  onExport?: () => void;
  onPrint?: () => void;
  onPermissions?: () => void; // implies canManage (caller gates)
  onRename?: (title: string) => void; // present ⇒ title is click-to-rename (edit-capable)
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
    <div className={styles.bar} data-testid="page-toolbar">
      {p.onRename
        ? <EditableTitle title={p.title} onRename={p.onRename} />
        : <span className={styles.title}>{p.title || t("common.untitled")}</span>}
      {p.publishState === "draft" && <span className={styles.chip} data-testid="draft-badge">{t("page.draft")}</span>}
      {p.publishState === "unpublished" && <span className={`${styles.chip} ${styles.chipDirty}`} data-testid="unpublished-badge">{t("page.unpublishedChanges")}</span>}
      <div className={styles.spacer} />
      <div className={styles.right}>
        {/* Comments is useful in both modes (read + while editing). */}
        {p.onToggleComments && (
          <IconButton aria-label={t("page.comments")} data-testid="comments-toggle" aria-pressed={p.commentsOpen} onClick={p.onToggleComments}>
            <MessageSquare size={15} />{p.openComments ? <span className={styles.commentBadge}>{p.openComments}</span> : null}
          </IconButton>
        )}
        {p.editing ? (
          <>
            {p.onToggleLayout && (
              <Button size="sm" variant="ghost" data-testid="layout-toggle" aria-pressed={p.layout === "split"} onClick={p.onToggleLayout}>
                <Columns2 size={14} /> {p.layout === "split" ? t("page.single") : t("page.split")}
              </Button>
            )}
            {p.onPublish && (
              <Button size="sm" variant="primary" data-testid="publish-page" disabled={p.publishing || !canPublish} onClick={p.onPublish}>
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
