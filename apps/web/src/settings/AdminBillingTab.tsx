import { useTranslation } from "react-i18next";
import { useBillingStatus, useEntitlements, useCheckout, usePortal } from "../data/queries";
import { Button } from "../ui/Button";
import { notify } from "../ui/toast";
import styles from "./SpaceThemeTab.module.css";

// Billing (Phase 5g, /admin/billing, tenant#admin). On self-host (billing disabled)
// it shows the "all features included" state. On Cloud it shows the current plan +
// Upgrade (Checkout) / Manage billing (Customer Portal). Team is contact-sales.
export function AdminBillingTab() {
  const { t } = useTranslation();
  const status = useBillingStatus();
  const ent = useEntitlements();
  const checkout = useCheckout();
  const portal = usePortal();

  const plan = status.data?.plan ?? "free";
  const planLabel = t([`billing.plan_${plan}`, "billing.plan_free"]);

  const goCheckout = (p: string) => checkout.mutate(p, {
    onSuccess: (r) => { if (r?.url) window.location.href = r.url; },
    onError: () => notify.error(t("toast.actionFailed")),
  });
  const goPortal = () => portal.mutate(undefined, {
    onSuccess: (r) => { if (r?.url) window.location.href = r.url; },
    onError: () => notify.error(t("billing.portalUnavailable")),
  });

  if (status.isLoading) return <div className={styles.wrap}><p className={styles.body}>{t("common.loading")}</p></div>;

  // Self-host / CE: no billing.
  if (!status.data?.billingEnabled) {
    return (
      <div className={styles.wrap} data-testid="admin-billing">
        <h2 style={{ marginTop: 0 }}>{t("billing.title")}</h2>
        <p className={styles.body} data-testid="billing-selfhosted">{t("billing.selfHosted")}</p>
      </div>
    );
  }

  return (
    <div className={styles.wrap} data-testid="admin-billing">
      <h2 style={{ marginTop: 0 }}>{t("billing.title")}</h2>
      <p className={styles.body}>{t("billing.currentPlan")} <strong data-testid="billing-plan">{planLabel}</strong></p>
      <p className={styles.body}>{t("billing.branding")}: {ent.data?.branding ? t("billing.included") : t("billing.notIncluded")}</p>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        {plan !== "pro" && plan !== "team" && (
          <Button variant="primary" size="sm" disabled={checkout.isPending} onClick={() => goCheckout("pro")} data-testid="billing-upgrade">{t("billing.upgradePro")}</Button>
        )}
        <Button variant="default" size="sm" disabled={portal.isPending} onClick={goPortal} data-testid="billing-manage">{t("billing.manage")}</Button>
      </div>
      <p className={styles.body} style={{ marginTop: 16 }}>{t("billing.teamNote")}</p>
    </div>
  );
}
