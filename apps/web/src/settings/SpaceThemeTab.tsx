import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useEntitlements, useUpdateSpaceBranding } from "../data/queries";
import { notify } from "../ui/toast";
import { AccentPicker } from "./AccentPicker";

interface SpaceCtx { spaceId: string; name: string; accentKey: string | null }

// Space Theme (Phase 5c). Sets the space's branding accent — inherited from tenant
// ▷ default when cleared. manage + entitlement gated server-side; the UI shows an
// upgrade notice when branding isn't entitled (Cloud free). Personal light/dark is
// separate (header switcher) and always available.
export function SpaceThemeTab() {
  const { t } = useTranslation();
  const { spaceId, accentKey } = useOutletContext<SpaceCtx>();
  const ent = useEntitlements();
  const update = useUpdateSpaceBranding(spaceId);
  const locked = ent.data ? !ent.data.branding : false;

  const choose = (key: string | null) => {
    update.mutate(key, {
      onSuccess: () => notify.success(t("toast.saved")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  return (
    <div className="max-w-[560px] p-6" data-testid="space-theme">
      <h2 className="mt-0">{t("spaceTheme.title")}</h2>
      <p className="mb-5 mt-0 text-sm text-fg-dim">{t("spaceTheme.body")}</p>

      {locked && (
        <div className="mb-5 rounded-lg border border-border border-l-[3px] border-l-[var(--accent)] bg-panel px-3.5 py-3" data-testid="branding-upgrade">
          <strong className="text-sm">{t("branding.upgradeTitle")}</strong>
          <p className="mb-0 mt-1 text-xs text-fg-dim">{t("branding.upgradeBody")}</p>
        </div>
      )}

      <AccentPicker
        value={accentKey}
        onChange={choose}
        disabled={locked || update.isPending}
        inheritLabel={t("spaceTheme.inherit")}
      />
    </div>
  );
}
