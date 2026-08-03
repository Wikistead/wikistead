import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { assetUrl } from "../data/apiClient";

// #568 / ADR-198 §3: the password sign-in form. Every other method on this screen is a button that
// hands the browser to somebody else; this one is the only place the product itself asks for a
// credential, so it is a form rather than a link.
//
// The failure copy is ONE message for every cause, matching what the server answers. Saying "no such
// account" here would hand back the enumeration answer the API deliberately withholds — and the
// screen is the easiest place in the product to ask that question a thousand times.
export function LocalLoginForm({ returnTo, disabled }: { returnTo: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"credentials" | "needsAddress" | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !identifier.trim() || !password) return;
    setBusy(true);
    setFailed(null);
    try {
      const res = await fetch(assetUrl("/auth/local/login"), {
        method: "POST",
        credentials: "include", // the response SETS the session cookie — it must be kept
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier, password, returnTo }),
      });
      if (!res.ok) { setFailed("credentials"); setBusy(false); return; }
      const body = (await res.json().catch(() => null)) as { returnTo?: string } | null;
      // A full navigation, not a router push: the session cookie is new, and every query in the app
      // was made by whoever was here before.
      window.location.href = body?.returnTo || returnTo || "/";
    } catch {
      setFailed("credentials");
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={submit} data-testid="login-local">
      {failed && (
        <div className="rounded-md border border-border border-l-[3px] border-l-[var(--danger)] bg-panel-2 px-3 py-2 text-sm"
          data-testid="login-local-error" role="alert">
          {t(failed === "needsAddress" ? "auth.resetNeedsAddress" : "auth.localFailed")}
        </div>
      )}
      <Input
        type="email" autoComplete="username" value={identifier} disabled={disabled || busy}
        placeholder={t("auth.localIdentifier")} aria-label={t("auth.localIdentifier")}
        data-testid="login-local-identifier" onChange={(e) => setIdentifier(e.target.value)}
      />
      <Input
        type="password" autoComplete="current-password" value={password} disabled={disabled || busy}
        placeholder={t("auth.localPassword")} aria-label={t("auth.localPassword")}
        data-testid="login-local-password" onChange={(e) => setPassword(e.target.value)}
      />
      <Button variant="primary" type="submit" className="w-full" data-testid="login-local-submit"
        disabled={disabled || busy || !identifier.trim() || !password}>
        {busy && <Loader2 size={16} className="animate-spin" data-testid="login-spinner" />}
        {t("auth.signIn")}
      </Button>
      {/* review R3: without this, the reset endpoints were live and nobody could reach them — an
          unauthenticated surface with no user. The confirmation is the same whatever happened,
          because the server answers the same whatever happened. */}
      {sent ? (
        <p className="m-0 text-xs text-fg-dim" data-testid="login-local-reset-sent">{t("auth.resetSent")}</p>
      ) : (
        <button type="button" className="m-0 self-start bg-transparent p-0 text-xs text-fg-dim underline"
          data-testid="login-local-forgot" disabled={busy}
          onClick={async () => {
            // A blank field asks for nothing; the person needs to type the address first.
            if (!identifier.trim()) { setFailed("needsAddress"); return; }
            setBusy(true);
            await fetch(assetUrl("/auth/local/reset-request"), {
              method: "POST", credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ identifier }),
            }).catch(() => {});
            setBusy(false);
            setSent(true);
          }}>
          {t("auth.forgotPassword")}
        </button>
      )}
    </form>
  );
}
