import { useTranslation } from "react-i18next";
import { shouldShowUpgradeAffordance, type DisclosureKind, type ViewerRole } from "./upgrade-affordance";

// The single place the client renders an access-loss upgrade affordance (#109 / ADR-072). It is the
// keystone that prevents an authz loss from EVER leaking an "upgrade" hint: the visibility decision
// runs through shouldShowUpgradeAffordance, so:
//   - kind="authz"        → renders nothing (existence-hiding), regardless of role.
//   - kind="entitlement"  → renders ONLY for owner/admin (a member/guest sees the stripped state).
//   - kind=null           → renders nothing (not a disclosure case).
// Callers compute `kind` from either an error (disclosureKindFromError) or a proactive entitlement
// flag (e.g. `locked ? "entitlement" : null`). Copy is overridable so feature-specific tabs keep
// their wording; the default copy is generic. The actual DOM/styling is a review observation.
export function UpgradeNotice({
  kind,
  isAdmin,
  testId = "upgrade-notice",
  title,
  body,
}: {
  kind: DisclosureKind | null;
  isAdmin: boolean;
  testId?: string;
  title?: string;
  body?: string;
}) {
  const { t } = useTranslation();
  const role: ViewerRole = isAdmin ? "admin" : "member";
  if (!kind || !shouldShowUpgradeAffordance(kind, role)) return null;
  return (
    <div
      className="mb-5 rounded-lg border border-border border-l-[3px] border-l-[var(--accent)] bg-panel px-3.5 py-3"
      data-testid={testId}
      role="status"
    >
      <strong className="text-sm">{title ?? t("upgrade.title")}</strong>
      <p className="mb-0 mt-1 text-xs text-fg-dim">{body ?? t("upgrade.body")}</p>
    </div>
  );
}
