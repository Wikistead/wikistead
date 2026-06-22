import { Pencil, Share2, MessageSquare, History, Download, Printer, Shield, Columns2, Check } from "lucide-react";
import { Button, IconButton } from "../ui/Button";
import { OverflowMenu, type OverflowItem } from "../ui/OverflowMenu";
import type { EditorLayout } from "../editor/Editor";
import styles from "./PageToolbar.module.css";

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
}

export function PageToolbar(p: PageToolbarProps) {
  const overflow: OverflowItem[] = [];
  if (p.onExport) overflow.push({ value: "export", label: "Export", icon: <Download size={14} />, testId: "export-page" });
  if (p.onPrint) overflow.push({ value: "print", label: "Print / PDF", icon: <Printer size={14} />, testId: "print-page" });
  if (p.onHistory) overflow.push({ value: "history", label: "History", icon: <History size={14} />, testId: "history-toggle" });
  if (p.onPermissions) overflow.push({ value: "permissions", label: "Permissions", icon: <Shield size={14} />, testId: "permissions-open" });
  const onOverflow = (v: string) => {
    if (v === "export") p.onExport?.();
    else if (v === "print") p.onPrint?.();
    else if (v === "history") p.onHistory?.();
    else if (v === "permissions") p.onPermissions?.();
  };

  return (
    <div className={styles.bar} data-testid="page-toolbar">
      <span className={styles.title}>{p.title || "Untitled"}</span>
      {p.publishState === "draft" && <span className={styles.chip} data-testid="draft-badge">Draft</span>}
      {p.publishState === "unpublished" && <span className={`${styles.chip} ${styles.chipDirty}`} data-testid="unpublished-badge">Unpublished changes</span>}
      <div className={styles.spacer} />
      <div className={styles.right}>
        {/* Comments is useful in both modes (read + while editing). */}
        {p.onToggleComments && (
          <IconButton aria-label="Comments" data-testid="comments-toggle" aria-pressed={p.commentsOpen} onClick={p.onToggleComments}>
            <MessageSquare size={15} />{p.openComments ? <span className={styles.commentBadge}>{p.openComments}</span> : null}
          </IconButton>
        )}
        {p.editing ? (
          <>
            {p.onToggleLayout && (
              <Button size="sm" variant="ghost" data-testid="layout-toggle" aria-pressed={p.layout === "split"} onClick={p.onToggleLayout}>
                <Columns2 size={14} /> {p.layout === "split" ? "Single" : "Split"}
              </Button>
            )}
            {p.onPublish && (
              <Button size="sm" variant="primary" data-testid="publish-page" disabled={p.publishing || !p.canPublish} onClick={p.onPublish}>
                Publish
              </Button>
            )}
            <Button size="sm" data-testid="view-toggle" onClick={p.onDone}><Check size={14} /> Done</Button>
          </>
        ) : (
          <>
            {p.canEdit && <Button size="sm" data-testid="edit-toggle" onClick={p.onEdit}><Pencil size={14} /> Edit</Button>}
            {p.onShare && <Button size="sm" variant="ghost" data-testid="share-open" onClick={p.onShare}><Share2 size={14} /> Share</Button>}
          </>
        )}
        {/* Secondary actions are one click away in both modes. */}
        {overflow.length > 0 && <OverflowMenu items={overflow} onSelect={onOverflow} />}
      </div>
    </div>
  );
}
