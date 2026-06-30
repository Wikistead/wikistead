import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBranding, useEntitlements, useUpdateTenantBranding, useUploadTenantLogo, useRemoveTenantLogo } from "../data/queries";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { notify } from "../ui/toast";
import { AccentPicker } from "./AccentPicker";
import { assetUrl } from "../data/apiClient";
import { UpgradeNotice } from "../ui/UpgradeNotice";
import { useSession } from "../session/SessionProvider";

const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_TYPES = /^image\/(png|jpeg|webp)$/;

// Tenant Branding (Phase 5d). The cascade root below space settings: sets the
// workspace-wide accent + the header wordmark (display name). admin + entitlement
// gated server-side; the tab shows an upgrade notice when branding isn't entitled.
// (Tenant logo upload is Phase 5d-2, pending the multipart dependency.)
export function TenantBrandingTab() {
  const { t } = useTranslation();
  const { isAdmin } = useSession();
  const branding = useBranding();
  const ent = useEntitlements();
  const update = useUpdateTenantBranding();
  const uploadLogo = useUploadTenantLogo();
  const removeLogo = useRemoveTenantLogo();
  const fileRef = useRef<HTMLInputElement>(null);
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
  const onPickLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    // Client-side guards for UX; the server re-validates (magic bytes + size).
    if (!LOGO_TYPES.test(file.type)) { notify.error(t("tenantBranding.logoType")); return; }
    if (file.size > LOGO_MAX_BYTES) { notify.error(t("tenantBranding.logoSize")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result);
      const b64 = res.slice(res.indexOf(",") + 1); // strip the data: URL prefix
      uploadLogo.mutate(b64, {
        onSuccess: () => notify.success(t("toast.saved")),
        onError: () => notify.error(t("toast.actionFailed")),
      });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="max-w-[560px] p-6" data-testid="tenant-branding">
      <h2 style={{ marginTop: 0 }}>{t("tenantBranding.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("tenantBranding.body")}</p>

      <UpgradeNotice
        kind={locked ? "entitlement" : null}
        isAdmin={isAdmin}
        testId="branding-upgrade"
        title={t("branding.upgradeTitle")}
        body={t("branding.upgradeBody")}
      />

      <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", marginBottom: 6 }}>{t("tenantBranding.displayName")}</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 28 }}>
        <Input className="max-w-xs" value={name} onChange={(e) => setName(e.target.value)} disabled={locked}
          placeholder={t("tenantBranding.displayNamePlaceholder")} aria-label={t("tenantBranding.displayName")} data-testid="tenant-name-input" />
        <Button variant="primary" size="sm" disabled={locked || update.isPending || name.trim() === (branding.data?.displayName ?? "")} onClick={saveName} data-testid="tenant-name-save">{t("common.save")}</Button>
      </div>

      <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", marginBottom: 10 }}>{t("accent.label")}</label>
      <AccentPicker value={accentKey} onChange={chooseAccent} disabled={locked || update.isPending} inheritLabel={t("tenantBranding.default")} />

      <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", margin: "28px 0 6px" }}>{t("tenantBranding.logo")}</label>
      <p className="mt-0 text-sm text-fg-dim" style={{ marginTop: 0 }}>{t("tenantBranding.logoHint")}</p>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {branding.data?.logoUrl && (
          <img src={assetUrl(branding.data.logoUrl)} alt="logo" data-testid="tenant-logo-preview" style={{ height: 28, maxWidth: 160, objectFit: "contain", border: "1px solid var(--border)", borderRadius: 4, padding: 2 }} />
        )}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="tenant-logo-input" onChange={onPickLogo} />
        <Button variant="default" size="sm" disabled={locked || uploadLogo.isPending} onClick={() => fileRef.current?.click()} data-testid="tenant-logo-upload">{t("tenantBranding.logoUpload")}</Button>
        {branding.data?.logoUrl && (
          <Button variant="dangerGhost" size="sm" disabled={locked || removeLogo.isPending} data-testid="tenant-logo-remove"
            onClick={() => removeLogo.mutate(undefined, { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("toast.actionFailed")) })}>{t("tenantBranding.logoRemove")}</Button>
        )}
      </div>
    </div>
  );
}
