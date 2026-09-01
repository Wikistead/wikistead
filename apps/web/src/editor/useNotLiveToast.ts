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
// open. A GRACE_MS delay before the FIRST-EVER live fixes that without hiding a real failure: once
// the connection HAS been live, every later disconnect shows with NO grace — that is the dangerous
// direction (losing edits mid-keystroke), and delaying it would work against the ruling's purpose.
// The grace timer is armed once per pre-live window and is not restarted by a bounce between non-null
// reasons (connecting → syncing → connecting …) — resetting it on every reason change would let a
// fast reconnect loop hide a genuine outage forever.
//
// #994 / ADR-276 composes with that, and the composition is why `live` is a parameter of its own
// rather than being read off `reason === null` as it was when #980 landed. This hook's `reason` is
// now the answer of `toastReason` below, which nulls it whenever there is nothing to SAY — including
// on a connection that has never been live. Latching "has been live" on that null would set it at
// mount, on every page, and #980's grace would become unreachable code with its own unit tests still
// green. The two gates answer different questions and both still run: #980 asks WHEN the pre-live
// window has gone on long enough to be worth reporting, #994 asks WHETHER there is anything at risk
// to report. The dangerous direction — an edit lost after the connection had been working — is
// delayed by neither.
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

// #994 / ADR-276 owner ruling ②: `read-only` gets its OWN title. The others are all "what you typed
// has not gone anywhere yet", which is what the shared title says; losing edit rights is a different
// fact, and it is announced without waiting for a keystroke (see `toastReason`), so the shared title
// would be claiming unsaved changes that may not exist. It is also an implementation necessity: a
// read-only server answers `writeSyncStatus(false)` and never decrements, so once a reader HAS typed
// under the shared title the toast would sit there saying "not saved" for the rest of the session.
const TITLE: Partial<Record<NotLiveReason, string>> = {
  "read-only": "collab.notSaving.readOnlyTitle",
};

/** How long a not-yet-live editor may sit disconnected before the toast shows. 670ms measured
 *  on one machine leaves only 19% headroom at 800ms; 2000ms costs nothing since it only delays a
 *  state nothing has been typed into yet. Exported so tests share one number instead of a duplicated
 *  literal drifting out of sync with the implementation. */
export const GRACE_MS = 2000;

/**
 * #994 / ADR-276: what the toast should carry — the CONNECTION's reason, gated on there being real
 * unsent CONTENT.
 *
 * Both call sites go through this rather than repeating the expression, so the two editing surfaces
 * cannot drift apart (they already did once — #978 fixed the view-only gate on one of them).
 */
export function toastReason(s: { canEdit: boolean; reason: NotLiveReason | null; unsynced: boolean }): NotLiveReason | null {
  // #978 a view-only surface never joins the collab room, so its `liveness` sits at the
  // initial `{live:false, reason:"connecting"}` forever with no event that could ever clear it.
  if (!s.canEdit) return null;
  // ADR-276 owner ruling ②: losing edit rights is not the kind of fact you wait for a keystroke to
  // report. It bypasses the latch and is said at once — under its own title, see `TITLE`.
  if (s.reason === "read-only") return s.reason;
  // ADR-276 §Decision: everything else is a waiting state. Say "your changes are not being saved"
  // only when there ARE changes that are not being saved.
  return s.unsynced ? s.reason : null;
}

export function useNotLiveToast(id: string, reason: NotLiveReason | null, live = false) {
  const { t } = useTranslation();
  const hasBeenLive = useRef(false);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestReason = useRef<NotLiveReason | null>(null);

  useEffect(() => {
    const show = (r: NotLiveReason) => notify.persistent(id, t(TITLE[r] ?? "collab.notSaving.title"), t(KEY[r]));
    latestReason.current = reason;
    // #994: the CONNECTION's own answer, not "the toast had nothing to say" — see the header.
    if (live) hasBeenLive.current = true;

    if (reason === null) {
      if (graceTimer.current !== null) {
        clearTimeout(graceTimer.current);
        graceTimer.current = null;
      }
      notify.dismiss(id);
      return;
    }

    // #994 owner ruling ②: read-only skips the grace as well as the unsent-edit gate. The grace is
    // for the handshake, a state that resolves itself in well under a second; read-only is the one
    // reason `liveness.ts` calls out as "not a waiting state and will not fix itself".
    if (hasBeenLive.current || reason === "read-only") {
      // post-live disconnect: no grace, show immediately (§2).
      show(reason);
      return;
    }

    // pre-live: a timer already running covers this bounce too — do not restart it.
    if (graceTimer.current === null) {
      graceTimer.current = setTimeout(() => {
        graceTimer.current = null;
        const r = latestReason.current;
        if (r) show(r);
      }, GRACE_MS);
    }
  }, [id, reason, live, t]);

  useEffect(() => () => {
    if (graceTimer.current !== null) clearTimeout(graceTimer.current);
    notify.dismiss(id);
  }, [id]);
}
