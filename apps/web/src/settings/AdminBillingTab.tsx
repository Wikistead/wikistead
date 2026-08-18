import { useTranslation } from "react-i18next";
import { useBillingStatus, useBillingUsage, useEntitlements, useCheckout, usePortal, useCustomDomains, type UsageResource } from "../data/queries";
import { Button } from "../ui/Button";
import { notify } from "../ui/toast";
import { SETTINGS_WIDTHS } from "./SettingsShell"; // #735: the column width is a named step, not a number

// Billing (Phase 5g, /admin/billing, tenant#admin). On self-host (billing disabled)
// it shows the "all features included" state. On Cloud it shows the current plan +
// Upgrade (Checkout) / Manage billing (Customer Portal). Team is contact-sales.
// #231: the counters `recordUsage` has been writing since #383, with nothing reading them back. What
// this deliberately does NOT do: warn, nag, or colour anything. What counts as "too much" is a
// pricing ruling (#127), and a screen that decided it first would be deciding it.
function UsageSection({ resources }: { resources: UsageResource[] }) {
  const { t } = useTranslation();
  if (resources.length === 0) return null;
  const fmt = new Intl.NumberFormat();
  return (
    <div className="mt-4 border-t border-border pt-3" data-testid="billing-usage">
      <p className="m-0 mb-2 text-xs font-medium text-fg-dim">{t("billing.usageTitle")}</p>
      <div className="flex flex-col gap-1">
        {resources.map((r) => (
          <div key={r.resource} className="flex items-baseline justify-between text-sm" data-testid={`billing-usage-${r.resource}`}>
            <span className="text-fg-dim">{t([`billing.resource_${r.resource}`, "billing.resource_other"], { resource: r.resource })}</span>
            <span>
              {/* `allowance: null` is UNLIMITED. Printing it as a number would say zero, which is the
                  opposite — so the two cases are different sentences, not a formatting branch. */}
              {r.allowance === null
                ? t("billing.usedUnlimited", { used: fmt.format(r.used) })
                : t("billing.usedOf", { used: fmt.format(r.used), allowance: fmt.format(r.allowance) })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AdminBillingTab() {
  const { t } = useTranslation();
  const status = useBillingStatus();
  const usage = useBillingUsage();
  const ent = useEntitlements();
  const checkout = useCheckout();
  const portal = usePortal();
  // ADR-230 §3 / #721 what a downgrade takes away, said where the plan is changed.
  const domains = useCustomDomains();

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

  if (status.isLoading) return <div data-settings-pane="form" className={SETTINGS_WIDTHS.form}><p className="mt-0 text-sm text-fg-dim">{t("common.loading")}</p></div>;

  // Self-host / CE: no billing.
  if (!status.data?.billingEnabled) {
    return (
      <div data-settings-pane="form" className={SETTINGS_WIDTHS.form} data-testid="admin-billing">
        <h2 style={{ marginTop: 0 }}>{t("billing.title")}</h2>
        <p className="mt-0 text-sm text-fg-dim" data-testid="billing-selfhosted">{t("billing.selfHosted")}</p>
        {/* Metering runs on self-host too, and "what has this deployment used" is a real question
            even when nothing is billed for it. */}
        <UsageSection resources={usage.data?.resources ?? []} />
      </div>
    );
  }

  return (
    <div data-settings-pane="form" className={SETTINGS_WIDTHS.form} data-testid="admin-billing">
      <h2 style={{ marginTop: 0 }}>{t("billing.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("billing.currentPlan")} <strong data-testid="billing-plan">{planLabel}</strong></p>
      <p className="mt-0 text-sm text-fg-dim">{t("billing.branding")}: {ent.data?.branding ? t("billing.included") : t("billing.notIncluded")}</p>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        {plan !== "pro" && plan !== "team" && (
          <Button variant="primary" size="sm" disabled={checkout.isPending} onClick={() => goCheckout("pro")} data-testid="billing-upgrade">{t("billing.upgradePro")}</Button>
        )}
        <Button variant="default" size="sm" disabled={portal.isPending} onClick={goPortal} data-testid="billing-manage">{t("billing.manage")}</Button>
      </div>
      {/* ADR-230 §3: a downgrade releases the workspace's custom domains, and getting one back means
          proving ownership again. That is the half worth knowing BEFORE leaving: the plan is changed
          in Stripe's portal, so this is the last screen we own on the way there. The domains are
          NAMED, because "you may lose custom domains" is advice while "docs.example.com stops
          resolving" is a fact somebody can act on. Silent when there are none, so it never becomes
          furniture.
          ⚠️ The wording here avoids the metering vocabulary on purpose: #231's pin keeps price, cap
          constants and threshold language off this screen (#127's rulings), and it reads the file as
          text. This sentence is about a domain being released, not about a limit being approached. */}
      {(domains.data?.length ?? 0) > 0 && (
        <p className="mt-4 text-sm text-fg-dim" data-testid="billing-domains-released">
          {t("billing.domainsAtRisk", { domains: (domains.data ?? []).map((d) => d.domain).join(", ") })}
        </p>
      )}
      <UsageSection resources={usage.data?.resources ?? []} />
      <p className="mt-0 text-sm text-fg-dim" style={{ marginTop: 16 }}>{t("billing.teamNote")}</p>
    </div>
  );
}
