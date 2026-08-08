import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { assetUrl } from "../data/apiClient";
import { isServerFault } from "./serverFault";

// #568 / ADR-198 §2 §6: choose a password. The same form serves the two moments a password is set —
// accepting a password invite, and completing a reset — because they ask the same thing and fail the
// same way; only the endpoint differs.
//
// The two failures are deliberately NOT the same message. "Too short" is about what the person just
// typed and they need it; "this link does not work" covers unknown, expired, consumed and a tenant
// that stopped offering passwords, all at once, because telling those apart would say something
// about the tenant to whoever is holding a dead link.
export const PASSWORD_MIN = 12;

export function SetPasswordForm({ token, mode, onDone }: { token: string; mode: "accept" | "reset"; onDone: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"weak" | "mismatch" | "link" | "unavailable" | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if ([...password].length < PASSWORD_MIN) return setError("weak");
    if (password !== confirm) return setError("mismatch");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(assetUrl(mode === "accept" ? "/auth/local/accept" : "/auth/local/reset"), {
        method: "POST",
        credentials: "include", // accepting signs them in — the response sets the session cookie
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) { onDone(); return; }
      // The server's own weak-password refusal (its policy is the authority; ours is a courtesy so
      // the person is not told after a round trip).
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      // #681: "this link is dead" is a claim about the LINK. A 500 is a claim about the server, and
      // telling someone their invitation expired when it did not sends them to ask for a new one that
      // will fail the same way.
      if (isServerFault(res)) { setError("unavailable"); setBusy(false); return; }
      setError(body?.code === "weak_password" ? "weak" : "link");
    } catch {
      setError("unavailable");
    }
    setBusy(false);
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={submit} data-testid="set-password">
      {error && (
        <div className="wks-left-bar rounded-md border border-border bg-panel-2 px-3 py-2 text-sm [--wks-left-bar-color:var(--danger)] [--wks-left-bar-pad:0.75rem]"
          data-testid="set-password-error" role="alert">
          {t(error === "weak" ? "auth.passwordTooShort" : error === "mismatch" ? "auth.passwordMismatch" : error === "unavailable" ? "auth.temporarilyUnavailable" : "auth.linkDead")}
        </div>
      )}
      <Input type="password" autoComplete="new-password" value={password} disabled={busy}
        placeholder={t("auth.newPassword")} aria-label={t("auth.newPassword")}
        data-testid="set-password-input" onChange={(e) => setPassword(e.target.value)} />
      <Input type="password" autoComplete="new-password" value={confirm} disabled={busy}
        placeholder={t("auth.confirmPassword")} aria-label={t("auth.confirmPassword")}
        data-testid="set-password-confirm" onChange={(e) => setConfirm(e.target.value)} />
      <p className="m-0 text-xs text-fg-dim">{t("auth.passwordHint", { min: PASSWORD_MIN })}</p>
      <Button variant="primary" type="submit" className="w-full" data-testid="set-password-submit" disabled={busy || !password || !confirm}>
        {busy && <Loader2 size={16} className="animate-spin" />}
        {t("auth.setPassword")}
      </Button>
    </form>
  );
}
