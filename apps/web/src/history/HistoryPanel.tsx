import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { usePageRevisions, useRestoreRevision, type Revision } from "../data/queries";
import { ConfirmDialog } from "../ui/dialogs";
import styles from "./HistoryPanel.module.css";

// Page history: lists the snapshot revisions (newest first) and, for edit-capable
// users, restores the page to a chosen one. Backend (GET list / POST restore) has
// existed since Phase 0; this is the UI that was missing. Restore is non-destructive
// (a CRDT delta + a fresh revision) and propagates to the open editor live, so the
// document updates in place — no reload. The server re-checks FGA on both calls.
function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
// created_by is stored as the FGA subject ("user:<sub>"); show just the sub.
function author(createdBy: string | null): string {
  if (!createdBy) return "unknown";
  return createdBy.startsWith("user:") ? createdBy.slice(5) : createdBy;
}

export function HistoryPanel({ pageId, canRestore }: { pageId: string; canRestore: boolean }) {
  const { data: revisions, isLoading } = usePageRevisions(pageId);
  const restore = useRestoreRevision(pageId);
  const [confirming, setConfirming] = useState<Revision | null>(null);

  return (
    <aside className={styles.panel} data-testid="history-panel">
      <div className={styles.header}>
        <strong>History</strong>
      </div>

      {isLoading && <p className={styles.hint}>Loading…</p>}
      {!isLoading && (revisions?.length ?? 0) === 0 && (
        <p className={styles.hint}>No saved versions yet. Versions are captured automatically as the page is edited.</p>
      )}

      <ul className={styles.list}>
        {(revisions ?? []).map((rev) => (
          <li key={rev.id} className={styles.item} data-testid="revision-item">
            <div className={styles.meta}>
              <span className={styles.when}>{fmt(rev.createdAt)}</span>
              <span className={styles.who}>{author(rev.createdBy)}</span>
            </div>
            {canRestore && (
              <button
                type="button"
                className={styles.restoreBtn}
                data-testid="revision-restore"
                disabled={restore.isPending}
                onClick={() => setConfirming(rev)}
              >
                <RotateCcw size={13} aria-hidden /> Restore
              </button>
            )}
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={confirming !== null}
        title="Restore this version"
        message={confirming ? `Restore the page to the version from ${fmt(confirming.createdAt)}? Current content is kept in history, so you can undo this.` : ""}
        confirmLabel="Restore"
        tone="primary"
        confirmTestId="confirm-restore"
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) restore.mutate(confirming.id);
          setConfirming(null);
        }}
      />
    </aside>
  );
}
