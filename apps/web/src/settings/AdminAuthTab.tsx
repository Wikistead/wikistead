import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTenantOidc, useUpdateTenantOidc, useTestTenantOidc } from "../data/queries";
import { Button } from "../ui/Button";
import { notify } from "../ui/toast";
import styles from "./AdminAuthTab.module.css";

// Tenant OIDC (members' SSO) settings (Phase 5e). tenant#admin. Enabling a broken
// IdP would break every new login, so "Test connection" validates discovery and the
// server re-validates on save (enabling a bad issuer is rejected). The secret is
// write-only (blank keeps the stored one). The admin's live session is the recovery
// path if a change goes wrong.
export function AdminAuthTab() {
  const { t } = useTranslation();
  const oidc = useTenantOidc();
  const update = useUpdateTenantOidc();
  const test = useTestTenantOidc();

  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState("openid email profile");
  const [redirectUri, setRedirectUri] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error: string | null } | null>(null);

  // Seed the form from the stored config once it loads.
  const data = oidc.data;
  useEffect(() => {
    if (!data) return;
    setIssuer(data.issuer); setClientId(data.clientId); setScopes(data.scopes);
    setRedirectUri(data.redirectUri); setEnabled(data.enabled);
  }, [data]);

  const onTest = () => {
    setTestResult(null);
    test.mutate(issuer.trim(), { onSuccess: (r) => setTestResult(r), onError: () => setTestResult({ ok: false, error: t("adminAuth.testFail") }) });
  };
  const onSave = () => {
    update.mutate(
      { issuer, clientId, clientSecret: clientSecret ? clientSecret : undefined, scopes, redirectUri, enabled },
      {
        onSuccess: () => { notify.success(t("toast.saved")); setClientSecret(""); },
        onError: () => notify.error(t("adminAuth.saveFailed")),
      },
    );
  };

  return (
    <div className={styles.wrap} data-testid="admin-auth">
      <h2 style={{ marginTop: 0 }}>{t("adminAuth.title")}</h2>
      <p className={styles.body}>{t("adminAuth.body")}</p>
      <div className={styles.warning} data-testid="oidc-warning">{t("adminAuth.warning")}</div>

      <label className={styles.label}>{t("adminAuth.issuer")}</label>
      <input className={styles.input} value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://idp.example.com/" data-testid="oidc-issuer" />

      <label className={styles.label}>{t("adminAuth.clientId")}</label>
      <input className={styles.input} value={clientId} onChange={(e) => setClientId(e.target.value)} data-testid="oidc-client-id" />

      <label className={styles.label}>{t("adminAuth.clientSecret")}</label>
      <input className={styles.input} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
        placeholder={data?.hasSecret ? t("adminAuth.clientSecretKeep") : ""} data-testid="oidc-client-secret" />

      <label className={styles.label}>{t("adminAuth.scopes")}</label>
      <input className={styles.input} value={scopes} onChange={(e) => setScopes(e.target.value)} data-testid="oidc-scopes" />

      <label className={styles.label}>{t("adminAuth.redirectUri")}</label>
      <input className={styles.input} value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} placeholder="https://your-tenant.example.com/auth/callback" data-testid="oidc-redirect" />

      <label className={styles.checkbox}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="oidc-enabled" />
        {t("adminAuth.enabled")}
      </label>

      {testResult && (
        <div className={testResult.ok ? styles.ok : styles.fail} data-testid="oidc-test-result">
          {testResult.ok ? t("adminAuth.testOk") : (testResult.error ?? t("adminAuth.testFail"))}
        </div>
      )}

      <div className={styles.actions}>
        <Button variant="default" size="sm" disabled={!issuer.trim() || test.isPending} onClick={onTest} data-testid="oidc-test">
          {test.isPending ? t("adminAuth.testing") : t("adminAuth.test")}
        </Button>
        <Button variant="primary" size="sm" disabled={update.isPending} onClick={onSave} data-testid="oidc-save">{t("common.save")}</Button>
      </div>
    </div>
  );
}
