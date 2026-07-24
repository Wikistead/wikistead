import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, GitCompare, Undo2 } from "lucide-react";
import { usePageRevisions, useRestoreRevision, useRevertActorRun, type Revision } from "../data/queries";
import { ConfirmDialog } from "../ui/dialogs";
import { RightPanel } from "../ui/RightPanel";
import { PanelRowsSkeleton, useDelayedFlag } from "../ui/Skeleton"; // #457loading ≠ empty
import { notify } from "../ui/toast";
import { authorLabel, isGuestSub } from "../comments/AuthorChip";
import { latestRun, isRevertableRun } from "./revert-run"; // #327the bulk-revert guards

// Page history: lists the snapshot revisions (newest first) and, for edit-capable
// users, restores the page to a chosen one. Backend (GET list / POST restore) has
// existed since Phase 0; this is the UI that was missing. Restore is non-destructive
// (a CRDT delta + a fresh revision) and propagates to the open editor live, so the
// document updates in place — no reload. The server re-checks FGA on both calls.
//
// "Compare" (Design-5) opens a near-fullscreen split diff (DiffModal) via onCompare —
// an OVERLAY, so the editor stays mounted and presence/collab are untouched (ADR-019).
//
// #327 / ADR-143 (increment 2, canModerate only): when the newest revisions form ONE actor's contiguous
// run, moderators get a one-click "revert this guest's edits" (a single forward restore to the pre-run
// revision — the server re-derives the run, so this can never widen). The row appears ONLY for an
// ANONYMOUS actor (anon:/guest:) with 2+ revisions and an existing baseline (review ruling:
// a member's single edit must never grow a one-click that would restore a buried vandal version).
// Interleaved / member / single-edit cases use the plain per-revision diff + restore buttons — there is
// deliberately NO bulk affordance for them (the increment-3 author-highlight guide was removed,).
// NOTE (ADR-143/ADR-123): a revert restores PROSE exactly; live checkbox state is reconciled, so a
// vandal's toggles may persist.

// #206: the right-panel chrome (width / bg / slide-in / header / close / Esc) is the shared RightPanel.
const rowBtn = "inline-flex flex-none items-center gap-1 rounded border border-border bg-panel-2 px-2 py-[3px] text-xs text-foreground hover:bg-border disabled:cursor-default disabled:opacity-50";
// #504: restore-type triggers (restore / bulk revert) overwrite the CURRENT content, so their triggers
// carry the destructive tint at rest; the confirm dialogs stay tone=primary (they restore, not delete).
const rowBtnDanger = "inline-flex flex-none items-center gap-1 rounded border border-border bg-panel-2 px-2 py-[3px] text-xs text-destructive hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] hover:border-destructive disabled:cursor-default disabled:opacity-50";

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
// created_by is stored as the FGA subject / actor: "user:<sub>" (show the sub), or a guest actor
// "guest:<id>" / #331 `anon:<id>` (show the short "Guest 7f3a" pseudonym — the raw id / anon hex must NEVER be
// shown in full, ADR-138 C-6 reviewer condition 3; the old `.replace(/^(user|guest):/)` leaked the raw uuid).
// #379 / ADR-150: a member author resolves to their CHOSEN display name when customized (the shared
// /members/identities contract; `identities` is the batch-resolved map keyed by bare sub). Fallback =
// the client-side label (email local-part / sub) exactly as before; guests keep "Guest 7f3a".
function author(createdBy: string | null, unknown: string, guestWord: string, identities?: Record<string, { displayName: string | null }>): string {
  if (!createdBy) return unknown;
  if (createdBy.startsWith("user:")) {
    const sub = createdBy.slice(5);
    return identities?.[sub]?.displayName ?? authorLabel(sub, guestWord);
  }
  if (isGuestSub(createdBy)) return authorLabel(createdBy, guestWord);
  return createdBy;
}


export function HistoryPanel({
  pageId,
  canRestore,
  canModerate = false,
  onCompare,
  onClose,
}: {
  pageId: string;
  canRestore: boolean;
  canModerate?: boolean;
  onCompare: (revId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data: revisions, isLoading } = usePageRevisions(pageId);
  const restore = useRestoreRevision(pageId);
  const revertRun = useRevertActorRun(pageId);
  const [confirming, setConfirming] = useState<Revision | null>(null);
  const [confirmingRun, setConfirmingRun] = useState(false);

  // #523 / ADR-190 (slice E sweep): the customized-only /members/identities batch is GONE from this panel.
  // The server already resolves every member author fully (`createdByName`, #486) on this view-gated list,
  // so the extra request could only ever add a name the server had refused to resolve — it cannot, since
  // full resolution over the same RLS handle is a superset of the customized-only one. `author()` stays for
  // the cases the server deliberately does not name: guests/anon, and an unknown/departed author.
  const rawRun = canModerate ? latestRun(revisions ?? []) : null;
  //bulk revert exists only for an anonymous 2+ run — otherwise the history stays a plain list.
  const run = isRevertableRun(rawRun) ? rawRun : null;
  // The bulk-revert run is anonymous-only by contract (isRevertableRun requires a guest/anon actor), so
  // this label never names a member — it is the guest word plus the short id.
  const runAuthor = run ? author(run.actor, t("history.unknown"), t("common.guest")) : "";

  // #457the list load draws row skeletons (delay-gated — a fast fetch shows nothing), so
  // "revisions are coming" and "there are none" read differently. The empty wording stays as-is.
  const showSkeleton = useDelayedFlag(isLoading);

  return (
    <RightPanel testId="history-panel" title={t("history.title")} onClose={onClose}>
      {isLoading && showSkeleton && <PanelRowsSkeleton testid="history-skeleton" />}
      {!isLoading && (revisions?.length ?? 0) === 0 && <p className="m-0 text-sm text-fg-dim">{t("history.empty")}</p>}

      {/* #327 increment 2: the one-click per-actor revert, offered ONLY when it is honest (the newest
          revisions are one actor's run AND a pre-run revision exists to restore to). */}
      {run && run.hasBaseline && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-border bg-panel-2 p-2" data-testid="revert-run-row">
          <span className="min-w-0 text-xs text-fg-dim">{t("history.revertRunLabel", { author: runAuthor, count: run.count })}</span>
          <button type="button" className={rowBtnDanger} data-testid="revert-run" disabled={revertRun.isPending} onClick={() => setConfirmingRun(true)}>
            <Undo2 size={13} aria-hidden /> {t("history.revertRun")}
          </button>
        </div>
      )}
      {run && !run.hasBaseline && (
        <p className="mb-2 mt-0 text-xs text-fg-dim" data-testid="revert-run-no-baseline">{t("history.revertRunNoBaseline", { author: runAuthor })}</p>
      )}

      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {(revisions ?? []).map((rev) => (
          <li
            key={rev.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border p-2"
            data-testid="revision-item"
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-[0.85em]">{fmt(rev.createdAt)}</span>
              {/* #486: prefer the server-resolved name (covers un-customized members too); fall back to the
                  client formatting (guest labels, unknown author) when the server deliberately sent none. */}
              <span className="text-[0.75em] text-fg-dim">{rev.createdByName ?? author(rev.createdBy, t("history.unknown"), t("common.guest"))}</span>
            </div>
            <div className="flex flex-none gap-1.5">
              <button type="button" className={rowBtn} data-testid="revision-diff" onClick={() => onCompare(rev.id)}>
                <GitCompare size={13} aria-hidden /> {t("history.diff")}
              </button>
              {canRestore && (
                <button type="button" className={rowBtnDanger} data-testid="revision-restore" disabled={restore.isPending} onClick={() => setConfirming(rev)}>
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

      <ConfirmDialog
        open={confirmingRun}
        title={t("history.revertRunConfirmTitle")}
        message={run ? t("history.revertRunConfirm", { author: runAuthor, count: run.count }) : ""}
        confirmLabel={t("history.revertRun")}
        tone="primary"
        confirmTestId="confirm-revert-run"
        onClose={() => setConfirmingRun(false)}
        onConfirm={() => {
          if (run) revertRun.mutate(run.actor, {
            onSuccess: () => notify.success(t("toast.restored")),
            // a 409 here means the list raced (someone published meanwhile) — the message routes honestly.
            onError: () => notify.error(t("toast.restoreFailed")),
          });
          setConfirmingRun(false);
        }}
      />
    </RightPanel>
  );
}
