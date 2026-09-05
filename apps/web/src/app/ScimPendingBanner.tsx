import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NoticeBand } from "../ui/NoticeBand";
import { usePendingRemovalNotice } from "../data/queries";

// #1104's own key — a fixed name, not scoped by tenant/member id: only one pending-removal banner is
// ever relevant to a signed-in viewer at a time, so there is nothing to disambiguate.
const DISMISSED_KEY = "scim-pending-banner-dismissed";

// #1054 / ADR-275 rev3 §4 (A8): the tenant-wide in-product record for a deferred SCIM removal.
// MEMBER-ONLY chrome, never admin-gated — mounted in AppShell beside FirstRunOnboarding, same
// `onLogout &&` signal. `last_admin` fires when the pending member IS the tenant's only
// administrator, so an admin-limited notice would be unreachable in exactly the moment it would
// need to fire (the same reasoning that put the out-of-band email, #1051, on every member).
//
// `role="status"` (not "alert"): a standing condition, not a new event to interrupt on — the
// out-of-band email is the immediate signal (§4's own text). Copy mirrors the email's non-disclosure
// line verbatim (members.pendingBannerTitle/Body — no floor, no sub, no admin count).
//
// #1104 (owner ruling, #983's review): dismissable, but only for the CURRENT session —
// `sessionStorage`, not `localStorage`, so the in-product record ADR-275 §4 relies on cannot vanish
// for good. Cleared the moment `pending` resolves, so a LATER pending state (a fresh SCIM removal,
// not a reload of this one) is never pre-suppressed by an old dismissal.
export function ScimPendingBanner() {
  const { t } = useTranslation();
  const { data: pending } = usePendingRemovalNotice();
  const [dismissed, setDismissed] = useState(
    () => { try { return sessionStorage.getItem(DISMISSED_KEY) === "1"; } catch { return false; } },
  );
  useEffect(() => {
    // #1104 review: `pending` is `undefined` while the query is still in flight, not
    // yet "no pending removal" — clearing the dismissal record on every mount-before-the-answer wipe
    // recorded before the fetch resolves, so a dismissed banner reappeared on reload once the query
    // caught up. Only a CONFIRMED `false` means the removal is actually gone.
    if (pending !== false) return;
    setDismissed(false);
    try { sessionStorage.removeItem(DISMISSED_KEY); } catch { /* private mode / storage disabled */ }
  }, [pending]);
  if (!pending || dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISSED_KEY, "1"); } catch { /* private mode / storage disabled */ }
  };
  return (
    <NoticeBand
      kind="info" title={t("members.pendingBannerTitle")} role="status" testId="scim-pending-banner"
      onDismiss={dismiss} dismissLabel={t("common.close")}
    >
      {t("members.pendingBannerBody")}
    </NoticeBand>
  );
}
