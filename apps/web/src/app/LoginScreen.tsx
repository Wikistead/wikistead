import { useTranslation } from "react-i18next";
import { AppShell } from "./AppShell";
import { Button } from "../ui/Button";

// Shown when there is no member session (real mode). Kicks off the OIDC flow as a
// top-level navigation to /auth/login (preserving where the user wanted to go).
export function LoginScreen() {
  const { t } = useTranslation();
  const returnTo = window.location.pathname + window.location.search;
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 420 }}>
        <h2 style={{ marginTop: 0 }}>{t("auth.signInTitle")}</h2>
        <p style={{ color: "var(--fg-dim)" }}>{t("auth.signInBody")}</p>
        <Button
          variant="primary"
          onClick={() => { window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`; }}
        >
          {t("auth.signIn")}
        </Button>
      </div>
    </AppShell>
  );
}
