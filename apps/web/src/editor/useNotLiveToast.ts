// #978 / ADR-261: the not-live state as a dismissible persistent toast, replacing the #813 band
// (ADR-248 §3.2, superseded by ADR-261 — a band, not a lock still holds; a toast now carries it).
//
// One editor instance owns one toast id. A `reason` change updates that SAME toast (`notify.persistent`
// keys on `id`, so Sonner replaces the existing one rather than stacking a new one) instead of the
// connecting → syncing → read-only sequence flashing three separate toasts. `reason` becoming null
// (live again) dismisses it, and so does unmounting — a page this component no longer represents must
// not leave a stale toast behind.
//
// Dismissal is NOT fought: the effect only re-fires when `reason` (or `id`) actually changes, so a
// reader who presses the close button keeps it closed until the state genuinely moves to a different
// reason — the #978 owner ruling reads a manual dismiss as "the reader has taken in the content".
//
// #980 (owner ruling, 2026-08-28): the connecting → syncing → live handshake normally
// completes in 400-670ms, well inside a single mount, so the toast fired and dismissed on every page
// open. A GRACE_MS delay before the FIRST-EVER `live` fixes that without hiding a real failure: once
// `reason` has gone null once (live achieved), every later disconnect shows with NO grace — that is
// the dangerous direction (losing edits mid-keystroke), and delaying it would work against the
// ruling's purpose. The grace timer is armed once per pre-live window and is not restarted by a
// bounce between non-null reasons (connecting → syncing → connecting …) — resetting it on every
// reason change would let a fast reconnect loop hide a genuine outage forever.
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "../ui/toast";
import type { NotLiveReason } from "./liveness";

const KEY: Record<NotLiveReason, string> = {
  connecting: "collab.notSaving.connecting",
  unauthenticated: "collab.notSaving.unauthenticated",
  "read-only": "collab.notSaving.readOnly",
  syncing: "collab.notSaving.syncing",
};

/** How long a not-yet-live editor may sit disconnected before the toast shows. 670ms measured
 *  on one machine leaves only 19% headroom at 800ms; 2000ms costs nothing since it only delays a
 *  state nothing has been typed into yet. Exported so tests share one number instead of a duplicated
 *  literal drifting out of sync with the implementation. */
export const GRACE_MS = 2000;

export function useNotLiveToast(id: string, reason: NotLiveReason | null) {
  const { t } = useTranslation();
  const hasBeenLive = useRef(false);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestReason = useRef<NotLiveReason | null>(null);

  useEffect(() => {
    latestReason.current = reason;

    if (reason === null) {
      if (graceTimer.current !== null) {
        clearTimeout(graceTimer.current);
        graceTimer.current = null;
      }
      hasBeenLive.current = true;
      notify.dismiss(id);
      return;
    }

    if (hasBeenLive.current) {
      // post-live disconnect: no grace, show immediately (§2).
      notify.persistent(id, t("collab.notSaving.title"), t(KEY[reason]));
      return;
    }

    // pre-live: a timer already running covers this bounce too — do not restart it.
    if (graceTimer.current === null) {
      graceTimer.current = setTimeout(() => {
        graceTimer.current = null;
        const r = latestReason.current;
        if (r) notify.persistent(id, t("collab.notSaving.title"), t(KEY[r]));
      }, GRACE_MS);
    }
  }, [id, reason, t]);

  useEffect(() => () => {
    if (graceTimer.current !== null) clearTimeout(graceTimer.current);
    notify.dismiss(id);
  }, [id]);
}
