import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBranding, useEntitlements, useUpdateTenantBranding, useUploadTenantLogo, useRemoveTenantLogo } from "../data/queries";
import { Button } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { Input } from "../ui/Input";
import { notify } from "../ui/toast";
import { AccentPicker } from "./AccentPicker";
import { assetUrl } from "../data/apiClient";
import { UpgradeNotice } from "../ui/UpgradeNotice";
import { useSession } from "../session/SessionProvider";

const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_TYPES = /^image\/(png|jpeg|webp)$/;

// Tenant Branding (Phase 5d). The cascade root below space settings: sets the
// workspace-wide accent + the header wordmark (display name). #109/ADR-072: basic
// customization (display name + accent colour) is FREE on all plans — we charge for
// freedom, not features. Only the ORIGINAL LOGO upload is entitlement-gated, so the
// upgrade affordance and the disabled state are scoped to the logo control alone
// (never the whole tab — a wholesale feature ban is the level-cap anti-pattern).
export function TenantBrandingTab() {
  const { t } = useTranslation();
  const { isAdmin } = useSession();
  const branding = useBranding();
  const ent = useEntitlements();
  const update = useUpdateTenantBranding();
  const uploadLogo = useUploadTenantLogo();
  const removeLogo = useRemoveTenantLogo();
  const fileRef = useRef<HTMLInputElement>(null);
  // The branding entitlement gates ONLY the logo (name + colour are basic, all plans).
  const logoLocked = ent.data ? !ent.data.branding : false;

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

      {/* Display name + accent are BASIC — no upgrade notice, never disabled by plan. */}
      <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", marginBottom: 6 }}>{t("tenantBranding.displayName")}</label>
      <FormRow className="mb-7">
        <Input className="max-w-xs" value={name} onChange={(e) => setName(e.target.value)}
          placeholder={t("tenantBranding.displayNamePlaceholder")} aria-label={t("tenantBranding.displayName")} data-testid="tenant-name-input" />
        <Button variant="primary" disabled={update.isPending || name.trim() === (branding.data?.displayName ?? "")} onClick={saveName} data-testid="tenant-name-save">{t("common.save")}</Button>
      </FormRow>

      <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", marginBottom: 10 }}>{t("accent.label")}</label>
      {/* #201: the tenant is the TOP of the accent cascade — always a concrete colour, no inherit chip. */}
      <AccentPicker value={accentKey} onChange={chooseAccent} disabled={update.isPending} inheritLabel={t("tenantBranding.default")} allowInherit={false} />

      <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", margin: "28px 0 6px" }}>{t("tenantBranding.logo")}</label>
      <p className="mt-0 text-sm text-fg-dim" style={{ marginTop: 0 }}>{t("tenantBranding.logoHint")}</p>
      {/* #109/ADR-072: the upgrade affordance is scoped to the LOGO only (the sole gated control),
          shown to owner/admin only via UpgradeNotice — not the whole branding tab. */}
      <UpgradeNotice
        kind={logoLocked ? "entitlement" : null}
        isAdmin={isAdmin}
        testId="branding-upgrade"
        title={t("branding.upgradeTitle")}
        body={t("branding.upgradeBody")}
      />
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {branding.data?.logoUrl && (
          <img src={assetUrl(branding.data.logoUrl)} alt="logo" data-testid="tenant-logo-preview" style={{ height: 28, maxWidth: 160, objectFit: "contain", border: "1px solid var(--border)", borderRadius: 4, padding: 2 }} />
        )}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="tenant-logo-input" onChange={onPickLogo} />
        <Button variant="default" size="sm" disabled={logoLocked || uploadLogo.isPending} onClick={() => fileRef.current?.click()} data-testid="tenant-logo-upload">{t("tenantBranding.logoUpload")}</Button>
        {branding.data?.logoUrl && (
          <Button variant="dangerGhost" size="sm" disabled={logoLocked || removeLogo.isPending} data-testid="tenant-logo-remove"
            onClick={() => removeLogo.mutate(undefined, { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("toast.actionFailed")) })}>{t("tenantBranding.logoRemove")}</Button>
        )}
      </div>
    </div>
  );
}
