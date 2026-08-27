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
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "../ui/toast";
import type { NotLiveReason } from "./liveness";

const KEY: Record<NotLiveReason, string> = {
  connecting: "collab.notSaving.connecting",
  unauthenticated: "collab.notSaving.unauthenticated",
  "read-only": "collab.notSaving.readOnly",
  syncing: "collab.notSaving.syncing",
};

export function useNotLiveToast(id: string, reason: NotLiveReason | null) {
  const { t } = useTranslation();
  useEffect(() => {
    if (reason) notify.persistent(id, t("collab.notSaving.title"), t(KEY[reason]));
    else notify.dismiss(id);
  }, [id, reason, t]);
  useEffect(() => () => { notify.dismiss(id); }, [id]);
}
