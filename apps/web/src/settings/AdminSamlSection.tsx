import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTenantSaml, useUpdateTenantSaml, type TenantSamlDTO } from "../data/queries";
import { ApiError } from "../data/apiClient";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Switch } from "../ui/Switch";
import { notify } from "../ui/toast";
import { UpgradeNotice } from "../ui/UpgradeNotice";
import { disclosureKindFromError } from "../ui/upgrade-affordance";

const label = "mb-1 mt-3.5 block text-sm text-fg-dim";

// #537 / ADR-195 §5: SAML gets the admin UI OIDC already has, on the same /admin/auth tab. EE-only
// by construction — the routes live in packages/ee-server, so a CE build answers 404 and the section
// renders NOTHING (existence-hiding is fine here: nothing was configured, nothing "vanishes"). An
// unentitled plan on an EE build answers 403+upgrade → UpgradeNotice (ADR-072 admin surface: a 404
// there would read as "your configuration was deleted"). The IdP signing cert is WRITE-ONLY.
export type SamlSectionState =
  | { kind: "hidden" } // CE build: route not mounted (404) — no SAML anywhere, show nothing
  | { kind: "locked" } // EE build, unentitled plan (403+upgrade) — UpgradeNotice
  | { kind: "form"; data: TenantSamlDTO | null }; // entitled (data null = not configured yet)

// Pure classifier so the three-way branch is unit-testable without rendering.
export function samlSectionState(q: { isError: boolean; error: unknown; data?: TenantSamlDTO | null }): SamlSectionState {
  if (q.isError) {
    const status = q.error instanceof ApiError ? q.error.status : undefined;
    if (status === 404) return { kind: "hidden" };
    if (status === 403) return { kind: "locked" };
    return { kind: "hidden" }; // unknown failure: never render a half-broken auth form
  }
  return { kind: "form", data: q.data ?? null };
}

export function AdminSamlSection() {
  const { t } = useTranslation();
  const saml = useTenantSaml();
  const update = useUpdateTenantSaml();

  const [idpEntityId, setIdpEntityId] = useState("");
  const [ssoUrl, setSsoUrl] = useState("");
  const [idpCert, setIdpCert] = useState(""); // write-only: blank keeps the stored cert
  const [spEntityId, setSpEntityId] = useState("");
  const [acsUrl, setAcsUrl] = useState("");
  const [attrEmail, setAttrEmail] = useState("");
  const [attrName, setAttrName] = useState("");
  const [attrGroups, setAttrGroups] = useState("");
  const [enabled, setEnabled] = useState(false);

  const data = saml.data;
  useEffect(() => {
    if (!data) return;
    setIdpEntityId(data.idpEntityId); setSsoUrl(data.ssoUrl); setSpEntityId(data.spEntityId);
    setAcsUrl(data.acsUrl); setAttrEmail(data.attrEmail ?? ""); setAttrName(data.attrName ?? "");
    setAttrGroups(data.attrGroups ?? ""); setEnabled(data.enabled);
  }, [data]);

  if (saml.isPending) return null;
  const state = samlSectionState(saml);
  if (state.kind === "hidden") return null;
  if (state.kind === "locked") {
    return (
      // #589: this lives INSIDE the SAML row of the sign-in methods list now — the row draws the
      // frame and says the name, so the section brings only its own contents.
      <div className="border-t border-border pt-2" data-testid="admin-saml">
        <UpgradeNotice kind={disclosureKindFromError(saml.error as ApiError)} isAdmin testId="saml-upgrade"
          title={t("adminAuth.samlLockedTitle")} body={t("adminAuth.samlLockedBody")} />
      </div>
    );
  }

  // The SP metadata an IdP admin needs (ADR-195 §5): our ACS endpoint on this tenant's own origin.
  const suggestedAcs = `${window.location.origin.replace(/\/$/, "")}/auth/saml/acs`;

  const onSave = () => {
    update.mutate(
      {
        idpEntityId, ssoUrl, idpCert: idpCert.trim() ? idpCert : undefined,
        spEntityId, acsUrl,
        attrEmail: attrEmail.trim() || null, attrName: attrName.trim() || null, attrGroups: attrGroups.trim() || null,
        enabled,
      },
      {
        onSuccess: () => { notify.success(t("toast.saved")); setIdpCert(""); },
        onError: (e) => {
          const code = e instanceof ApiError ? e.code : undefined;
          notify.error(code === "saml_cert_required" ? t("adminAuth.samlCertRequired") : t("adminAuth.saveFailed"));
        },
      },
    );
  };

  return (
    <div className="border-t border-border pt-2" data-testid="admin-saml">
      <p className="mt-0 text-sm text-fg-dim">{t("adminAuth.samlBody")}</p>
      {/* What the IdP side needs from us — shown up front so the admin can register the SP first. */}
      <div className="mb-4 rounded-lg border border-border bg-panel px-3 py-2.5 text-xs text-fg-dim" data-testid="saml-sp-metadata">
        {t("adminAuth.samlSpHint")} <code className="select-all">{suggestedAcs}</code>
      </div>

      <label className={label}>{t("adminAuth.samlIdpEntityId")}</label>
      <Input value={idpEntityId} onChange={(e) => setIdpEntityId(e.target.value)} placeholder="https://idp.example.com/metadata" data-testid="saml-idp-entity" />

      <label className={label}>{t("adminAuth.samlSsoUrl")}</label>
      <Input value={ssoUrl} onChange={(e) => setSsoUrl(e.target.value)} placeholder="https://idp.example.com/sso" data-testid="saml-sso-url" />

      <label className={label}>{t("adminAuth.samlCert")}</label>
      <textarea
        className="min-h-24 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs"
        value={idpCert} onChange={(e) => setIdpCert(e.target.value)}
        placeholder={data?.hasCert ? t("adminAuth.samlCertKeep") : "-----BEGIN CERTIFICATE-----"}
        data-testid="saml-cert"
      />

      <label className={label}>{t("adminAuth.samlSpEntityId")}</label>
      <Input value={spEntityId} onChange={(e) => setSpEntityId(e.target.value)} placeholder={window.location.origin} data-testid="saml-sp-entity" />

      <label className={label}>{t("adminAuth.samlAcsUrl")}</label>
      <Input value={acsUrl} onChange={(e) => setAcsUrl(e.target.value)} placeholder={suggestedAcs} data-testid="saml-acs-url" />

      <label className={label}>{t("adminAuth.samlAttrs")}</label>
      <div className="grid grid-cols-3 gap-2">
        <Input value={attrEmail} onChange={(e) => setAttrEmail(e.target.value)} placeholder={t("adminAuth.samlAttrEmail")} data-testid="saml-attr-email" />
        <Input value={attrName} onChange={(e) => setAttrName(e.target.value)} placeholder={t("adminAuth.samlAttrName")} data-testid="saml-attr-name" />
        <Input value={attrGroups} onChange={(e) => setAttrGroups(e.target.value)} placeholder={t("adminAuth.samlAttrGroups")} data-testid="saml-attr-groups" />
      </div>

      <label className="my-4 mb-1 flex items-center gap-2 text-sm">
        <Switch checked={enabled} onChange={setEnabled} testId="saml-enabled" />
        {t("adminAuth.samlEnabled")}
      </label>

      <div className="mt-5 flex gap-2">
        <Button variant="primary" size="sm" disabled={update.isPending} onClick={onSave} data-testid="saml-save">{t("common.save")}</Button>
      </div>
    </div>
  );
}
