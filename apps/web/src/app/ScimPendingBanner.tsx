import { useTranslation } from "react-i18next";
import { NoticeBand } from "../ui/NoticeBand";
import { usePendingRemovalNotice } from "../data/queries";

// #1054 / ADR-275 rev3 §4 (A8): the tenant-wide in-product record for a deferred SCIM removal.
// MEMBER-ONLY chrome, never admin-gated — mounted in AppShell beside FirstRunOnboarding, same
// `onLogout &&` signal. `last_admin` fires when the pending member IS the tenant's only
// administrator, so an admin-limited notice would be unreachable in exactly the moment it would
// need to fire (the same reasoning that put the out-of-band email, #1051, on every member).
//
// `role="status"` (not "alert"): a standing condition, not a new event to interrupt on — the
// out-of-band email is the immediate signal (§4's own text). Copy mirrors the email's non-disclosure
// line verbatim (members.pendingBannerTitle/Body — no floor, no sub, no admin count).
export function ScimPendingBanner() {
  const { t } = useTranslation();
  const { data: pending } = usePendingRemovalNotice();
  if (!pending) return null;
  return (
    <NoticeBand kind="info" title={t("members.pendingBannerTitle")} role="status" testId="scim-pending-banner">
      {t("members.pendingBannerBody")}
    </NoticeBand>
  );
}
