import { useTranslation } from "react-i18next";
import { useLoginMethods, useUpdatePlatformLogin, type LoginMethodState } from "../data/queries";
import { ApiError } from "../data/apiClient";
import { Switch } from "../ui/Switch";
import { notify } from "../ui/toast";

// #537 / ADR-195 Slice 3: the admin's "which ways in exist" panel. Three rows, one per method; the
// per-IdP on/off lives with each IdP's own config (OIDC form above, SAML section below) — the ONLY
// switch here is platform login (ruling 4: off requires an effective own IdP; the server answers
// 409 own_idp_required otherwise, surfaced as a specific message).
//
// §1's display rule: a method the CEILING excludes is shown as unavailable-BY-POLICY (never
// silently off) — the tenant's stored selection is untouched and returns with the ceiling.
export type MethodBadge = "effective" | "byPolicy" | "unentitled" | "off";
export function methodBadge(m: LoginMethodState & { entitled?: boolean }): MethodBadge {
  if (m.effective) return "effective";
  // The selection is the tenant's own; when policy is what stops it, say so (§1). Same for the plan
  // (ADR-072: entitlement loss on an admin surface is named to admins, data preserved).
  if (!m.inCeiling && m.selected) return "byPolicy";
  if (m.entitled === false && m.selected) return "unentitled";
  return "off";
}

export function AdminLoginMethodsSection() {
  const { t } = useTranslation();
  const q = useLoginMethods();
  const update = useUpdatePlatformLogin();
  const m = q.data?.methods;
  if (!m) return null; // pending or failed — the IdP config forms below stand on their own

  const onTogglePlatform = (on: boolean) => {
    update.mutate(on, {
      onSuccess: () => notify.success(t("toast.saved")),
      onError: (e) => {
        const code = e instanceof ApiError ? e.code : undefined;
        // NOT adminAuth.saveFailed — that copy talks about the connection test, which has no
        // meaning for this toggle (design-review Slice 3, finding 5).
        notify.error(code === "own_idp_required" ? t("adminAuth.platformOwnIdpRequired") : t("adminAuth.methodsSaveFailed"));
      },
    });
  };

  const row = (key: string, label: string, state: LoginMethodState, control?: React.ReactNode) => {
    const badge = methodBadge(state);
    return (
      <div key={key} className="flex items-center justify-between border-b border-border py-2 last:border-b-0" data-testid={`login-method-${key}`}>
        <span className="text-sm">{label}</span>
        <span className="flex items-center gap-3">
          <span
            className={badge === "effective" ? "text-xs text-[#2da44e]" : "text-xs text-fg-dim"}
            data-testid={`login-method-${key}-badge`}
          >
            {t(`adminAuth.method_${badge}`)}
          </span>
          {control}
        </span>
      </div>
    );
  };

  return (
    <div className="mb-6 rounded-lg border border-border px-4 py-2" data-testid="login-methods">
      <h3 className="my-2 text-sm font-semibold">{t("adminAuth.methodsTitle")}</h3>
      <p className="mt-0 text-xs text-fg-dim">{t("adminAuth.methodsBody")}</p>
      {row("tenant-oidc", t("adminAuth.methodTenantOidc"), m["tenant-oidc"])}
      {row(
        "platform-oidc",
        t("adminAuth.methodPlatformOidc"),
        m["platform-oidc"],
        m["platform-oidc"].inCeiling && m["platform-oidc"].configured ? (
          <Switch checked={m["platform-oidc"].selected} onChange={onTogglePlatform} testId="platform-login-toggle" />
        ) : undefined,
      )}
      {row("saml", t("adminAuth.methodSaml"), m.saml)}
    </div>
  );
}
