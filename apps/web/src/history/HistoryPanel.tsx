import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, X, GitCompare, ArrowLeft } from "lucide-react";
import { usePageRevisions, useRestoreRevision, useRevisionContent, usePublished, type Revision } from "../data/queries";
import { ConfirmDialog } from "../ui/dialogs";
import { useEscClose } from "../ui/useEscClose";
import { notify } from "../ui/toast";
import { lineDiff, hasChanges } from "./diff";
import styles from "./HistoryPanel.module.css";

// Page history: lists the snapshot revisions (newest first) and, for edit-capable
// users, restores the page to a chosen one. Backend (GET list / POST restore) has
// existed since Phase 0; this is the UI that was missing. Restore is non-destructive
// (a CRDT delta + a fresh revision) and propagates to the open editor live, so the
// document updates in place — no reload. The server re-checks FGA on both calls.
//
// Design-5: a "Compare" view diffs a chosen revision against the CURRENT published
// snapshot (line-level, no dependency — see diff.ts). Per ADR-019 D1/D2 the revision
// list is publishes only (checkbox ticks never snapshot), so the diff is meaningful; and
// because checkbox state is text, a toggled `[x]`/`[ ]` shows up as a changed line (D7).
function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
// created_by is stored as the FGA subject ("user:<sub>" / "guest:<id>"); show the sub.
function author(createdBy: string | null, unknown: string): string {
  if (!createdBy) return unknown;
  return createdBy.replace(/^(user|guest):/, "");
}

function DiffView({ pageId, rev, onBack }: { pageId: string; rev: Revision; onBack: () => void }) {
  const { t } = useTranslation();
  const { data: oldContent, isLoading } = useRevisionContent(pageId, rev.id);
  const { data: published } = usePublished(pageId);
  const lines = useMemo(
    () => (oldContent == null ? [] : lineDiff(oldContent, published?.publishedMd ?? "")),
    [oldContent, published?.publishedMd],
  );

  return (
    <div data-testid="history-diff">
      <div className={styles.diffHead}>
        <button type="button" className={styles.backBtn} data-testid="diff-back" onClick={onBack}>
          <ArrowLeft size={13} aria-hidden /> {t("history.backToList")}
        </button>
      </div>
      <p className={styles.diffTitle}>{t("history.diffTitle", { when: fmt(rev.createdAt) })}</p>
      <p className={styles.hint}>{t("history.diffHint")}</p>
      {isLoading && <p className={styles.hint}>{t("common.loading")}</p>}
      {!isLoading && !hasChanges(lines) && <p className={styles.hint}>{t("history.noChanges")}</p>}
      {!isLoading && hasChanges(lines) && (
        <code className={styles.diff} data-testid="diff-body">
          {lines.map((l, i) => (
            <span
              key={i}
              className={`${styles.diffLine} ${l.type === "add" ? styles.diffAdd : l.type === "del" ? styles.diffDel : styles.diffSame}`}
              data-difftype={l.type}
            >
              {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
              {l.text || " "}
            </span>
          ))}
        </code>
      )}
    </div>
  );
}

export function HistoryPanel({ pageId, canRestore, onClose }: { pageId: string; canRestore: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: revisions, isLoading } = usePageRevisions(pageId);
  const restore = useRestoreRevision(pageId);
  const [confirming, setConfirming] = useState<Revision | null>(null);
  const [diffing, setDiffing] = useState<Revision | null>(null);
  useEscClose(onClose);

  return (
    <aside className={styles.panel} data-testid="history-panel">
      <div className={styles.header}>
        <strong>{t("history.title")}</strong>
        <button type="button" className={styles.close} data-testid="history-close" aria-label={t("common.close")} onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </div>

      {diffing ? (
        <DiffView pageId={pageId} rev={diffing} onBack={() => setDiffing(null)} />
      ) : (
        <>
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
                  <button
                    type="button"
                    className={styles.restoreBtn}
                    data-testid="revision-diff"
                    onClick={() => setDiffing(rev)}
                  >
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
        </>
      )}

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
