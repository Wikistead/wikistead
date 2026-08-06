import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { OneTimeSecret } from "../ui/OneTimeSecret";
import { assetUrl } from "../data/apiClient";

// #652 / ADR-219 §6: the half-authenticated step. The password was right; the tenant requires one more
// thing, and there is no session yet — what stands in for one is a receipt cookie the server set, which
// only these two endpoints read.
//
// It lives on the SIGN-IN screen rather than behind a route of its own, because a route would need a
// principal to guard it and there is none: a reader who reloads has nothing but the cookie, and a page
// that reads a cookie it cannot see is a page that renders the wrong thing half the time. Reloading
// here starts the sign-in again, which costs a password and is honest.
//
// Two stages, not one. "Enter your code" is unanswerable to somebody who has never enrolled — §6's
// circle in miniature — so the server says which situation this is and the screen asks accordingly.
export function FactorStep({ stage, returnTo }: { stage: "required" | "enrolment-required"; returnTo: string }) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** the enrolment being set up, once started — the secret is handed over ONCE, in that response */
  const [enrolling, setEnrolling] = useState<{ factorId: string; secret: string } | null>(null);

  const post = async (path: string, body: unknown) =>
    fetch(assetUrl(path), {
      method: "POST",
      credentials: "include", // the receipt goes out and the SESSION comes back on this call
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /** Land in the product. A full navigation: the session cookie is new. */
  const arrive = async (res: Response) => {
    const body = (await res.json().catch(() => null)) as { returnTo?: string } | null;
    window.location.href = body?.returnTo || returnTo || "/";
  };

  const present = async () => {
    if (busy || !code.trim()) return;
    setBusy(true); setFailed(false);
    const res = await post("/auth/local/factor", { code: code.trim(), returnTo }).catch(() => null);
    if (!res?.ok) { setFailed(true); setBusy(false); return; }
    await arrive(res);
  };

  const startEnrolment = async () => {
    setBusy(true); setFailed(false);
    const res = await post("/auth/local/factor/enrol", {}).catch(() => null);
    if (!res?.ok) { setFailed(true); setBusy(false); return; }
    setEnrolling(await res.json() as { factorId: string; secret: string });
    setBusy(false);
  };

  const confirmEnrolment = async () => {
    if (busy || !enrolling || !code.trim()) return;
    setBusy(true); setFailed(false);
    const res = await post(`/auth/local/factor/enrol/${encodeURIComponent(enrolling.factorId)}/confirm`,
      { code: code.trim(), returnTo }).catch(() => null);
    if (!res?.ok) { setFailed(true); setBusy(false); return; }
    await arrive(res);
  };

  const codeBox = (onSubmit: () => void, testId: string) => (
    <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}>
      <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric"
        autoComplete="one-time-code" autoFocus disabled={busy}
        placeholder={t("auth.factorCodePlaceholder")} aria-label={t("auth.factorCode")}
        data-testid={`${testId}-code`} />
      <Button variant="primary" type="submit" className="w-full" disabled={busy || !code.trim()}
        data-testid={`${testId}-submit`}>
        {busy && <Loader2 size={16} className="animate-spin" />}
        {t("auth.factorContinue")}
      </Button>
    </form>
  );

  return (
    <div className="flex flex-col gap-2" data-testid="login-factor-step">
      {failed && (
        <div className="wks-left-bar rounded-md border border-border bg-panel-2 px-3 py-2 text-sm [--wks-left-bar-color:var(--danger)] [--wks-left-bar-pad:0.75rem]"
          data-testid="login-factor-error" role="alert">
          {t("auth.factorFailed")}
        </div>
      )}

      {stage === "required" ? (
        <>
          <p className="m-0 text-sm text-fg-dim" data-testid="login-factor-prompt">{t("auth.factorPrompt")}</p>
          {codeBox(present, "login-factor")}
        </>
      ) : enrolling ? (
        <>
          {/* The key goes to a phone standing in front of the reader, so it is the same one-time box a
              password link uses — shown once, copyable, and saying so. */}
          <p className="m-0 text-sm text-fg-dim">{t("auth.factorEnrolHint")}</p>
          <OneTimeSecret value={enrolling.secret} testId="login-factor-secret" grouped
            note={t("auth.factorSecretNote")} />
          {codeBox(confirmEnrolment, "login-factor-enrol")}
        </>
      ) : (
        <>
          {/* Nothing to present, so nothing to type yet. This is §6's circle: without this button the
              policy is unrecoverable for anybody who had not enrolled before it was turned on. */}
          <p className="m-0 text-sm text-fg-dim" data-testid="login-factor-prompt">{t("auth.factorEnrolPrompt")}</p>
          <Button variant="primary" className="w-full" disabled={busy}
            onClick={() => void startEnrolment()} data-testid="login-factor-enrol-start">
            {busy && <Loader2 size={16} className="animate-spin" />}
            {t("auth.factorEnrolStart")}
          </Button>
        </>
      )}
    </div>
  );
}
