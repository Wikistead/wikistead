import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { OneTimeSecret } from "../ui/OneTimeSecret";
import { QrCode } from "../ui/QrCode"; // #653 the same code the settings screen draws
import { assetUrl } from "../data/apiClient";
import { startRegistration } from "@simplewebauthn/browser"; // #678: a key made at the door
import { isServerFault } from "./serverFault";

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
export function FactorStep(
  { stage, kinds, returnTo }: { stage: "required" | "enrolment-required"; kinds?: string[]; returnTo: string },
) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  // #681: "that code is wrong" is a claim about the CODE. A 500 is not, and a person told their
  // correct code is wrong will keep re-reading their authenticator while the outage continues.
  const [failed, setFailed] = useState<false | "code" | "unavailable">(false);
  // #653 `uri` was in this response all along and the TYPE dropped it, so the sign-in screen
  // offered typing and nothing else while the settings screen — same server field — drew a QR. Reading
  // it here is the whole fix; the server is untouched.
  /** the enrolment being set up, once started — the secret is handed over ONCE, in that response */
  const [enrolling, setEnrolling] = useState<{ factorId: string; secret: string; uri: string } | null>(null);
  // #678: which kinds this workspace accepts. Absent (an older server, or `off`) reads as both, which
  // is what the screen offered before this existed — a default that adds nothing rather than one that
  // hides a door.
  const accepts = (kind: string) => !kinds?.length || kinds.includes(kind);
  // …and whether this browser can do WebAuthn AT ALL. Only the synchronous check (#672 ruling ③): the
  // platform-authenticator probe answers about a fingerprint reader, and a laptop without one would
  // still take a USB key — telling that person "this device cannot" turns a working setup into a
  // refusal.
  const webauthn = typeof window !== "undefined" && "PublicKeyCredential" in window;

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
    if (!res?.ok) { setFailed(isServerFault(res) ? "unavailable" : "code"); setBusy(false); return; }
    await arrive(res);
  };

  /** #678: register a key from here, the same two calls the settings panel makes. */
  const startPasskey = async () => {
    setBusy(true); setFailed(false);
    let started: { factorId: string; options: Record<string, unknown> } | null = null;
    try {
      const res = await post("/auth/local/factor/enrol/passkey", {});
      // classify BEFORE throwing: below, the same catch also sees the browser ceremony being
      // cancelled, and a person who pressed Escape has not hit an outage.
      if (!res.ok) { setFailed(isServerFault(res) ? "unavailable" : "code"); setBusy(false); return; }
      started = await res.json() as { factorId: string; options: Record<string, unknown> };
      const attestation = await startRegistration({ optionsJSON: started.options as never });
      const done = await post(`/auth/local/factor/enrol/${encodeURIComponent(started.factorId)}/passkey`,
        { response: attestation, returnTo });
      if (!done.ok) { setFailed(isServerFault(done) ? "unavailable" : "code"); setBusy(false); return; }
      await arrive(done);
    } catch {
      // ⚠️ NOT "unavailable": this catch also fires when the reader cancels the browser's key prompt,
      // and telling them the service is down would be a second wrong answer in the same place.
      setFailed("code"); setBusy(false);
    }
  };

  const startEnrolment = async () => {
    setBusy(true); setFailed(false);
    const res = await post("/auth/local/factor/enrol", {}).catch(() => null);
    if (!res?.ok) { setFailed(isServerFault(res) ? "unavailable" : "code"); setBusy(false); return; }
    setEnrolling(await res.json() as { factorId: string; secret: string; uri: string });
    setBusy(false);
  };

  const confirmEnrolment = async () => {
    if (busy || !enrolling || !code.trim()) return;
    setBusy(true); setFailed(false);
    const res = await post(`/auth/local/factor/enrol/${encodeURIComponent(enrolling.factorId)}/confirm`,
      { code: code.trim(), returnTo }).catch(() => null);
    if (!res?.ok) { setFailed(isServerFault(res) ? "unavailable" : "code"); setBusy(false); return; }
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
          {t(failed === "unavailable" ? "auth.temporarilyUnavailable" : "auth.factorFailed")}
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
          {/* The URI the SERVER built, drawn as-is — the same component and the same value the
              settings screen uses. Rebuilding it here would put the spelling of label, issuer, digits
              and period in a second place, and the day they drift the QR sets up one account while the
              typed key sets up another. */}
          <QrCode value={enrolling.uri} testId="login-factor-qr" />
          <span hidden data-testid="login-factor-uri">{enrolling.uri}</span>
          {/* #682 sweep: the box itself already prints "shown only once, copy it now"
              (`common.copyOnce`), and this note used to say it again in other words. That is the defect
              #653 ③ had ruled on and fixed — on the SETTINGS panel only; the same box on this
              screen kept the old wording, so the fix stopped at one of the two surfaces. The note now
              says the one thing the box does not: where the key goes. */}
          <OneTimeSecret value={enrolling.secret} testId="login-factor-secret" grouped
            note={t("auth.factorSecretNote")} />
          {codeBox(confirmEnrolment, "login-factor-enrol")}
        </>
      ) : (
        <>
          {/* Nothing to present, so nothing to type yet. This is §6's circle: without this button the
              policy is unrecoverable for anybody who had not enrolled before it was turned on. */}
          <p className="m-0 text-sm text-fg-dim" data-testid="login-factor-prompt">{t("auth.factorEnrolPrompt")}</p>
          {accepts("totp") && (
            <Button variant="primary" className="w-full" disabled={busy}
              onClick={() => void startEnrolment()} data-testid="login-factor-enrol-start">
              {busy && <Loader2 size={16} className="animate-spin" />}
              {t("auth.factorEnrolStart")}
            </Button>
          )}
          {accepts("passkey") && webauthn && (
            <Button variant={accepts("totp") ? "default" : "primary"} className="w-full" disabled={busy}
              onClick={() => void startPasskey()} data-testid="login-factor-enrol-passkey">
              {busy && <Loader2 size={16} className="animate-spin" />}
              {t("auth.factorEnrolPasskey")}
            </Button>
          )}
          {/* #672 ruling ③: stranding a browser without WebAuthn is accepted, and the LOCKOUT MUST BE
              LEGIBLE — the generic "that did not work" is what this replaces. Shown only when there is
              nothing else on offer; a tenant accepting both leaves this reader the other door. */}
          {!accepts("totp") && !webauthn && (
            <p className="m-0 text-sm text-[var(--danger)]" data-testid="login-factor-unsupported">
              {t("auth.factorNoWebauthn")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
