import { useTranslation } from "react-i18next";
import { usePublicSurface, useSetPublicSurface } from "../data/queries";
import { notify } from "../ui/toast";
import { Switch } from "../ui/Switch";

// #253 / ADR-113: the tenant PARENT SWITCH for the anonymous public surface. tenant#admin only (the GET/PUT
// re-check, 403 otherwise). Default OFF = fail-safe: the whole public surface 404s until an admin turns it on
// here — a structural block against accidental exposure. Turning it OFF is non-destructive (per-page public
// grants survive), so flipping it back ON restores every public page. The server is the fortress; this toggle
// is the control.
export function AdminPublicTab() {
  const { t } = useTranslation();
  const { data: enabled, isLoading } = usePublicSurface();
  const setSurface = useSetPublicSurface();

  const toggle = (v: boolean) =>
    setSurface.mutate(v, {
      onSuccess: () => notify.success(t("toast.saved")),
      onError: () => notify.error(t("toast.actionFailed")),
    });

  return (
    <div className="max-w-[560px] p-6" data-testid="admin-public">
      <h2 className="mt-0">{t("adminPublic.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("adminPublic.body")}</p>

      <label className="mt-4 flex items-start gap-2 rounded-md border border-border p-3" data-testid="public-surface-row">
        {/* #389 / ADR-146: bare checkbox -> DS Switch (on/off state). */}
        <Switch
          className="mt-0.5"
          testId="public-surface-toggle"
          checked={!!enabled}
          disabled={isLoading || setSurface.isPending}
          onChange={toggle}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-foreground">{t("adminPublic.toggleTitle")}</span>
          <span className="block text-xs text-fg-dim">{enabled ? t("adminPublic.onHint") : t("adminPublic.offHint")}</span>
        </span>
      </label>
    </div>
  );
}
