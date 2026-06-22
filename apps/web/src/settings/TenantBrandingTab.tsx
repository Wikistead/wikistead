import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBranding, useEntitlements, useUpdateTenantBranding } from "../data/queries";
import { Button } from "../ui/Button";
import { notify } from "../ui/toast";
import { AccentPicker } from "./AccentPicker";
import styles from "./SpaceThemeTab.module.css";

// Tenant Branding (Phase 5d). The cascade root below space settings: sets the
// workspace-wide accent + the header wordmark (display name). admin + entitlement
// gated server-side; the tab shows an upgrade notice when branding isn't entitled.
// (Tenant logo upload is Phase 5d-2, pending the multipart dependency.)
export function TenantBrandingTab() {
  const { t } = useTranslation();
  const branding = useBranding();
  const ent = useEntitlements();
  const update = useUpdateTenantBranding();
  const locked = ent.data ? !ent.data.branding : false;

  const accentKey = branding.data?.accentKey ?? null;
  const [name, setName] = useState("");
  // Seed the name field once branding loads (and on external changes).
  useEffect(() => { setName(branding.data?.displayName ?? ""); }, [branding.data?.displayName]);

  const chooseAccent = (key: string | null) => {
    update.mutate({ accentKey: key, displayName: branding.data?.displayName ?? null }, {
      onSuccess: () => notify.success(t("toast.saved")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };
  const saveName = () => {
    const next = name.trim();
    update.mutate({ accentKey, displayName: next === "" ? null : next }, {
      onSuccess: () => notify.success(t("toast.saved")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  return (
    <div className={styles.wrap} data-testid="tenant-branding">
      <h2 style={{ marginTop: 0 }}>{t("tenantBranding.title")}</h2>
      <p className={styles.body}>{t("tenantBranding.body")}</p>

      {locked && (
        <div className={styles.upgrade} data-testid="branding-upgrade">
          <strong>{t("branding.upgradeTitle")}</strong>
          <p>{t("branding.upgradeBody")}</p>
        </div>
      )}

      <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", marginBottom: 6 }}>{t("tenantBranding.displayName")}</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 28 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={locked}
          placeholder={t("tenantBranding.displayNamePlaceholder")} aria-label={t("tenantBranding.displayName")} data-testid="tenant-name-input" />
        <Button variant="primary" size="sm" disabled={locked || update.isPending || name.trim() === (branding.data?.displayName ?? "")} onClick={saveName} data-testid="tenant-name-save">{t("common.save")}</Button>
      </div>

      <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", marginBottom: 10 }}>{t("accent.label")}</label>
      <AccentPicker value={accentKey} onChange={chooseAccent} disabled={locked || update.isPending} inheritLabel={t("tenantBranding.default")} />
    </div>
  );
}
