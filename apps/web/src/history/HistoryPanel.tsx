import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, X, GitCompare } from "lucide-react";
import { usePageRevisions, useRestoreRevision, type Revision } from "../data/queries";
import { ConfirmDialog } from "../ui/dialogs";
import { useEscClose } from "../ui/useEscClose";
import { notify } from "../ui/toast";
import styles from "./HistoryPanel.module.css";

// Page history: lists the snapshot revisions (newest first) and, for edit-capable
// users, restores the page to a chosen one. Backend (GET list / POST restore) has
// existed since Phase 0; this is the UI that was missing. Restore is non-destructive
// (a CRDT delta + a fresh revision) and propagates to the open editor live, so the
// document updates in place — no reload. The server re-checks FGA on both calls.
//
// "Compare" (Design-5) opens a near-fullscreen split diff (DiffModal) via onCompare —
// an OVERLAY, so the editor stays mounted and presence/collab are untouched (ADR-019).
function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
// created_by is stored as the FGA subject ("user:<sub>" / "guest:<id>"); show the sub.
function author(createdBy: string | null, unknown: string): string {
  if (!createdBy) return unknown;
  return createdBy.replace(/^(user|guest):/, "");
}

export function HistoryPanel({
  pageId,
  canRestore,
  onCompare,
  onClose,
}: {
  pageId: string;
  canRestore: boolean;
  onCompare: (revId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data: revisions, isLoading } = usePageRevisions(pageId);
  const restore = useRestoreRevision(pageId);
  const [confirming, setConfirming] = useState<Revision | null>(null);
  useEscClose(onClose);

  return (
    <aside className={styles.panel} data-testid="history-panel">
      <div className={styles.header}>
        <strong>{t("history.title")}</strong>
        <button type="button" className={styles.close} data-testid="history-close" aria-label={t("common.close")} onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </div>

      {isLoading && <p className={styles.hint}>{t("common.loading")}</p>}
      {!isLoading && (revisions?.length ?? 0) === 0 && <p className={styles.hint}>{t("history.empty")}</p>}

      <ul className={styles.list}>
        {(revisions ?? []).map((rev) => (
          <li key={rev.id} className={styles.item} data-testid="revision-item">
            <div className={styles.meta}>
              <span className={styles.when}>{fmt(rev.createdAt)}</span>
              <span className={styles.who}>{author(rev.createdBy, t("history.unknown"))}</span>
            </div>
            <div className={styles.rowActions}>
              <button type="button" className={styles.restoreBtn} data-testid="revision-diff" onClick={() => onCompare(rev.id)}>
                <GitCompare size={13} aria-hidden /> {t("history.diff")}
              </button>
              {canRestore && (
                <button
                  type="button"
                  className={styles.restoreBtn}
                  data-testid="revision-restore"
                  disabled={restore.isPending}
                  onClick={() => setConfirming(rev)}
                >
                  <RotateCcw size={13} aria-hidden /> {t("history.restore")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={confirming !== null}
        title={t("history.restoreConfirmTitle")}
        message={confirming ? t("history.restoreConfirm", { when: fmt(confirming.createdAt) }) : ""}
        confirmLabel={t("history.restore")}
        tone="primary"
        confirmTestId="confirm-restore"
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) restore.mutate(confirming.id, {
            onSuccess: () => notify.success(t("toast.restored")),
            onError: () => notify.error(t("toast.restoreFailed")),
          });
          setConfirming(null);
        }}
      />
    </aside>
  );
}
