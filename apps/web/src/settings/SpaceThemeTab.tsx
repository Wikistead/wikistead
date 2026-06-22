import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useEntitlements, useUpdateSpaceBranding } from "../data/queries";
import { notify } from "../ui/toast";
import { AccentPicker } from "./AccentPicker";
import styles from "./SpaceThemeTab.module.css";

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
    <div className={styles.wrap} data-testid="space-theme">
      <h2 style={{ marginTop: 0 }}>{t("spaceTheme.title")}</h2>
      <p className={styles.body}>{t("spaceTheme.body")}</p>

      {locked && (
        <div className={styles.upgrade} data-testid="branding-upgrade">
          <strong>{t("branding.upgradeTitle")}</strong>
          <p>{t("branding.upgradeBody")}</p>
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
