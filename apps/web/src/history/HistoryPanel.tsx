import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, GitCompare } from "lucide-react";
import { usePageRevisions, useRestoreRevision, type Revision } from "../data/queries";
import { ConfirmDialog } from "../ui/dialogs";
import { RightPanel } from "../ui/RightPanel";
import { notify } from "../ui/toast";
import { authorLabel, isGuestSub } from "../comments/AuthorChip";

// Page history: lists the snapshot revisions (newest first) and, for edit-capable
// users, restores the page to a chosen one. Backend (GET list / POST restore) has
// existed since Phase 0; this is the UI that was missing. Restore is non-destructive
// (a CRDT delta + a fresh revision) and propagates to the open editor live, so the
// document updates in place — no reload. The server re-checks FGA on both calls.
//
// "Compare" (Design-5) opens a near-fullscreen split diff (DiffModal) via onCompare —
// an OVERLAY, so the editor stays mounted and presence/collab are untouched (ADR-019).

// #206: the right-panel chrome (width / bg / slide-in / header / close / Esc) is the shared RightPanel.
const rowBtn = "inline-flex flex-none items-center gap-1 rounded border border-border bg-panel-2 px-2 py-[3px] text-xs text-foreground hover:bg-border disabled:cursor-default disabled:opacity-50";

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
// created_by is stored as the FGA subject / actor: "user:<sub>" (show the sub), or a guest actor
// "guest:<id>" / #331 `anon:<id>` (show the short "Guest 7f3a" pseudonym — the raw id / anon hex must NEVER be
// shown in full, ADR-138 C-6 reviewer condition 3; the old `.replace(/^(user|guest):/)` leaked the raw uuid).
function author(createdBy: string | null, unknown: string, guestWord: string): string {
  if (!createdBy) return unknown;
  // #379: a member author showed the RAW sub (`createdBy.slice(5)` — a full email / opaque OIDC sub), unlike
  // the comment/PageMeta author displays which format it via `authorLabel` (email local-part). Route members
  // through the SAME shared formatter so the history reads consistently ("the owner", not "the owner@…"). NOTE: this
  // is the client-side label only; resolving to a member's chosen DISPLAY NAME + avatar needs an identity
  // endpoint (authz-gated) — the remaining, needs-review part of #379.
  if (createdBy.startsWith("user:")) return authorLabel(createdBy.slice(5), guestWord);
  if (isGuestSub(createdBy)) return authorLabel(createdBy, guestWord);
  return createdBy;
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

  return (
    <RightPanel testId="history-panel" title={t("history.title")} onClose={onClose}>
      {isLoading && <p className="m-0 text-sm text-fg-dim">{t("common.loading")}</p>}
      {!isLoading && (revisions?.length ?? 0) === 0 && <p className="m-0 text-sm text-fg-dim">{t("history.empty")}</p>}

      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {(revisions ?? []).map((rev) => (
          <li key={rev.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2" data-testid="revision-item">
            <div className="flex min-w-0 flex-col">
              <span className="text-[0.85em]">{fmt(rev.createdAt)}</span>
              <span className="text-[0.75em] text-fg-dim">{author(rev.createdBy, t("history.unknown"), t("common.guest"))}</span>
            </div>
            <div className="flex flex-none gap-1.5">
              <button type="button" className={rowBtn} data-testid="revision-diff" onClick={() => onCompare(rev.id)}>
                <GitCompare size={13} aria-hidden /> {t("history.diff")}
              </button>
              {canRestore && (
                <button type="button" className={rowBtn} data-testid="revision-restore" disabled={restore.isPending} onClick={() => setConfirming(rev)}>
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
    </RightPanel>
  );
}
