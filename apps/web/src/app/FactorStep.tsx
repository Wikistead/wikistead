import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { OneTimeSecret } from "../ui/OneTimeSecret";
import { QrCode } from "../ui/QrCode"; // #653the same code the settings screen draws
import { assetUrl } from "../data/apiClient";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser"; // #678: a key made at the door; #687: and presented at it
import { isServerFault } from "./serverFault";
import { factorKindsPhrase, factorKindName, browserCanUseFactorKind, proofBeginsOnChoice } from "../settings/factor-kind"; // #686: one home for the kind nouns

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
/**
 * The kinds the door offers, and where the member starts.
 *
 * #745 / ADR-240: a chooser is a new RENDERING of a set that already crossed the wire, so the property
 * worth holding is that the set is unchanged. Both halves are functions, and exported, for the reason
 * #650 found the hard way: the rendering assertions stay green while the derivation quietly changes,
 * so the derivation is the thing a pin has to be able to read.
 *
 * `kinds` is what the SERVER sent for this member — at `required` it is what THEY can present
 * (`auth-local.ts` sends `usable`, not the tenant's stance, and #687 recorded why that discloses
 * nothing new). The only filter added here is the device one: a key this browser cannot perform is a
 * fact about the window, not about the account, and offering it would be #606's refusal-only control.
 */
export function doorProofs(kinds: string[] | undefined, webauthn: boolean): string[] {
  // Absent kinds reads as "both" — an older server, or `off`. That was the screen's behaviour before
  // #678 existed, and a default that hides a door is worse than one that adds nothing.
  const offered = kinds?.length ? kinds : ['totp', 'passkey']
  // ⚠️ FIXED ORDER (owner ruling): authenticator app, then passkey. Not "the one you used last"
  // — that needs the door to carry state it has never had, and about the member at that.
  return ['totp', 'passkey'].filter((k) => offered.includes(k) && (k !== 'passkey' || webauthn))
}

/** One usable proof means no chooser: a menu with one item charges a click and answers nothing. */
export function doorInitialProof(proofs: readonly string[]): string | null {
  return proofs.length === 1 ? proofs[0]! : null
}

export function FactorStep(
  { stage, kinds, recovery, returnTo }: {
    stage: "required" | "enrolment-required"; kinds?: string[]; recovery?: boolean; returnTo: string;
  },
) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  // #650 / ADR-226: the recovery code box is BEHIND a link rather than beside the factor box. Somebody
  // who can reach their authenticator should use it — spending a code deletes every factor they hold —
  // so the way in that costs nothing stays the obvious one, and this is the door you go looking for.
  const [recovering, setRecovering] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [busy, setBusy] = useState(false);
  // #681: "that code is wrong" is a claim about the CODE. A 500 is not, and a person told their
  // correct code is wrong will keep re-reading their authenticator while the outage continues.
  const [failed, setFailed] = useState<false | "code" | "badCode" | "recovery" | "unavailable">(false);
  // #653`uri` was in this response all along and the TYPE dropped it, so the sign-in screen
  // offered typing and nothing else while the settings screen — same server field — drew a QR. Reading
  // it here is the whole fix; the server is untouched.
  /** the enrolment being set up, once started — the secret is handed over ONCE, in that response */
  const [enrolling, setEnrolling] = useState<{ factorId: string; secret: string; uri: string } | null>(null);
  // #678: which kinds this workspace accepts. Absent (an older server, or `off`) reads as both, which
  // is what the screen offered before this existed — a default that adds nothing rather than one that
  // hides a door.
  const accepts = (kind: string) => !kinds?.length || kinds.includes(kind);
  // …and whether this browser can do WebAuthn AT ALL. The SHARED predicate (#686): the account
  // panel asked a private copy of this question — no, it never asked — while this screen asked its
  // own, and the two surfaces drifted. The sync-only rule (#672 ruling ③: no platform-authenticator
  // probe) now lives in factor-kind.ts with the rest of the kind facts.
  const webauthn = browserCanUseFactorKind("passkey");
  // #745 / ADR-240: what this member may pick, and where they start. `picked === null` is the chooser;
  // a lone proof skips it (`doorInitialProof`) so nobody is charged a click for a decision with one
  // answer. The initial value is computed once — re-deriving it on every render would drag somebody
  // back to their single proof after they pressed "use something else", which only exists when there
  // is more than one.
  const proofs = doorProofs(kinds, webauthn);
  const [picked, setPicked] = useState<string | null>(() => doorInitialProof(doorProofs(kinds, webauthn)));

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

  /**
    * #686 family B: a code the server REFUSED is not "that did not work".
    *
    * The account panel has said "that code did not match" since #657; the two surfaces on the sign-in
    * side collapsed every non-5xx failure into one generic sentence. It is the same shape #673 and #681
    * each fixed once — a person who mistyped six digits is told nothing, and retypes the same thing.
    *
    * Read from the server's CODE, never from its prose (#578: replacing an error sentence silently
    * broke four places that matched on it). Anything the server does not name that way keeps the
    * generic sentence, because "the code is wrong" said about a rate limit is a new wrong answer.
    */
  const classify = async (res: Response | null): Promise<"unavailable" | "badCode" | "code"> => {
    if (isServerFault(res)) return "unavailable";
    const body = await res?.clone().json().catch(() => null) as { code?: string } | null;
    return body?.code === "factor_code_invalid" ? "badCode" : "code";
  };

  const present = async () => {
    if (busy || !code.trim()) return;
    setBusy(true); setFailed(false);
    const res = await post("/auth/local/factor", { code: code.trim(), returnTo }).catch(() => null);
    if (!res?.ok) { setFailed(await classify(res)); setBusy(false); return; }
    await arrive(res);
  };

  /**
   * #650 / ADR-226 §4: spend a recovery code.
   *
   * The server answers ONE refusal for a wrong code, no set, a revoked set and the switch being off, so
   * there is nothing here to classify — `badCode` would be a claim the response does not make. On
   * success the session cookie comes back on this call, exactly as the factor door's does, and the
   * member arrives with no factors and a fresh set to enrol.
   */
  const presentRecovery = async () => {
    if (busy || !recoveryCode.trim()) return;
    setBusy(true); setFailed(false);
    const res = await post("/auth/local/factor/recovery", { code: recoveryCode.trim(), returnTo }).catch(() => null);
    if (!res?.ok) { setFailed(isServerFault(res) ? "unavailable" : "recovery"); setBusy(false); return; }
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

  /**
   * #687: PRESENT a passkey at the door. The lock-out this fixes: a member holding only a security
   * key reached a screen with a six-digit box and no other way forward — the server had accepted
   * assertions here since #665 and nothing on the screen ever asked for one.
   *
   * Two calls, mirroring the settings panel's removal flow: the server mints the challenge (it is a
   * write — see the route's own note), the browser proves the key, the assertion goes back to the
   * same `/auth/local/factor` that takes a code. The options are used AS RECEIVED — rebuilding them
   * here is what broke #666.
   */
  const presentPasskey = async () => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try {
      const res = await post("/auth/local/factor/passkey/options", {});
      // Classified before the ceremony, because the catch below also sees a cancelled prompt.
      if (!res.ok) { setFailed(await classify(res)); setBusy(false); return; }
      const { options } = await res.json() as { options: Record<string, unknown> };
      const assertion = await startAuthentication({ optionsJSON: options as never });
      const done = await post("/auth/local/factor", { passkey: assertion, returnTo });
      if (!done.ok) { setFailed(await classify(done)); setBusy(false); return; }
      await arrive(done);
    } catch {
      // ⚠️ NOT "unavailable" and NOT "badCode": this catch fires when the reader dismisses the
      // browser's key prompt or the key is absent. Neither is an outage, and neither is a wrong code.
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
    if (!res?.ok) { setFailed(await classify(res)); setBusy(false); return; }
    await arrive(res);
  };

  const codeBox = (onSubmit: () => void, testId: string) => (
    <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}>
      <label className="flex flex-col gap-1 text-xs text-fg-dim">
        {t("auth.factorCode")}
        <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric"
          autoComplete="one-time-code" autoFocus disabled={busy}
          placeholder={t("auth.factorCodePlaceholder")}
          data-testid={`${testId}-code`} />
      </label>
      <Button variant="primary" type="submit" className="w-full" disabled={busy || !code.trim()}
        data-testid={`${testId}-submit`}>
        {busy && <Loader2 size={16} className="animate-spin" />}
        {t("auth.factorContinue")}
      </Button>
    </form>
  );

  return (
    <div className="flex flex-col gap-2" data-testid="login-factor-step">
      {/* #745the STEP owns the heading. The password was already accepted by the time this
          renders, and the screens above kept saying what the previous stage wanted — the recovery door
          still read "sign in with your email address and password" directly over a row of second-factor
          buttons. A card whose title belongs to the screen cannot follow a reader who moves inside it,
          so the title moves in with the thing that changes. The hosts render their own only while no
          stage is up (they take `onStage` for exactly that). */}
      <div data-testid="login-factor-heading">
        <h1 className="mb-1 text-xl font-semibold">
          {t(stage === "required" ? "auth.factorTitle" : "auth.factorEnrolTitle")}
        </h1>
        {/* The enrolment stage says its piece further down, and it needs `kinds` to say it. */}
        {stage === "required" && (
          <p className="m-0 text-sm text-fg-dim" data-testid="login-factor-body">{t("auth.factorBody")}</p>
        )}
      </div>
      {failed && (
        <div className="wks-left-bar rounded-md border border-border bg-panel-2 px-3 py-2 text-sm [--wks-left-bar-color:var(--danger)] [--wks-left-bar-pad:0.75rem]"
          data-testid="login-factor-error" role="alert">
          {t(failed === "unavailable" ? "auth.temporarilyUnavailable"
            : failed === "badCode" ? "account.factorCodeWrong"
            // #650: the recovery door answers one refusal for four causes on purpose, so the sentence
            // must not name one of them ("that code is wrong" would be a guess about which it was).
            : failed === "recovery" ? "auth.recoveryCodeFailed"
            : "auth.factorFailed")}
        </div>
      )}

      {stage === "required" ? (
        <>
          {/* #745 / ADR-240: pick the proof, then use it — the same three steps, in the same order, as
              the recovery-code screen, so a member who has met one recognises the other. The prompt
              sentence went with the change (owner ruling): a button that says "authenticator
              app" already says what the sentence said.

              ⚠️ The chooser NEVER shrinks on a refusal, and the refusal keeps the door's single
              sentence. Removing the kind that just failed would turn offering into probing, and
              naming the cause would undo #650's four-causes-one-answer. */}
          {proofs.length === 0 ? (
            /* Nothing on offer: the member's only accepted kind needs WebAuthn and this browser has
               none. Same ruling as the enrolment side (#672 ③) — the lock-out is accepted, but it
               must be legible rather than an empty panel, and "no entries" is exactly the panel a
               chooser draws when nobody thinks about it. */
            <p className="m-0 text-sm text-[var(--danger)]" data-testid="login-factor-unsupported">
              {t("auth.factorNoWebauthn")}
            </p>
          ) : picked === null ? (
            <div className="flex flex-col gap-2" data-testid="login-factor-choices">
              {proofs.map((k, i) => (
                <Button key={k} variant={i === 0 ? "primary" : "default"} className="w-full" type="button"
                  data-testid={`login-factor-choose-${k}`}
                  /* #745choosing a passkey IS presenting it — the click that picks the kind is
                     the user activation the ceremony needs, so a second button asking to confirm was
                     a step with nothing in it. A code still has to be typed, which is why the rule
                     belongs to the kind (factor-kind.ts) rather than to this screen. */
                  onClick={() => { setPicked(k); if (proofBeginsOnChoice(k)) void presentPasskey(); }}>
                  {/* #671 / #686: the button says the product's own noun for the kind, from the one
                      place that owns those nouns — not a second copy of them living in this file. */}
                  {t("auth.factorChoose", { kind: factorKindName(k, t) })}
                </Button>
              ))}
            </div>
          ) : (
            <>
              {picked === "totp" && codeBox(present, "login-factor")}
              {picked === "passkey" && (
                /* Still here, and now it means "again": the ceremony started when the kind was chosen
                   (or, for a member with one proof, when they arrived and pressed this), and a reader
                   who dismissed the browser's prompt needs a way back in. Pressing it a second time is
                   a decision; pressing it the first time never was. */
                <Button variant="primary" className="w-full" disabled={busy}
                  onClick={() => void presentPasskey()} data-testid="login-factor-passkey">
                  {busy && <Loader2 size={16} className="animate-spin" />}
                  {t(failed ? "auth.factorPresentPasskeyAgain" : "auth.factorPresentPasskey")}
                </Button>
              )}
              {/* Only when there WAS a fork: where one proof exists the member never chose, so "use
                  something else" would point at a screen they have not seen. */}
              {proofs.length > 1 && (
                <Button variant="ghost" className="w-full" type="button" data-testid="login-factor-back"
                  onClick={() => setPicked(null)}>{t("auth.factorChooseOther")}</Button>
              )}
            </>
          )}
          {/* #650 / ADR-226: the way back for the person whose device is gone. Offered only when the
              server says this member holds a live set — a link to a box they cannot fill is the #606
              shape, a control whose only outcome is a refusal.

              NOT gated on `accepts()`: a recovery code is not a factor kind, so a passkey-only
              workspace does not refuse it. It is the reset path, and the reset path ignores kind
              policy exactly as the administrator's does. */}
          {recovery && (recovering ? (
            <form className="flex flex-col gap-2" data-testid="login-recovery-form"
              onSubmit={(e) => { e.preventDefault(); void presentRecovery(); }}>
              {/* Said BEFORE the box, not after: spending a code deletes every factor on the account,
                  and somebody who reads that afterwards has already pressed the button. */}
              <p className="m-0 text-sm text-fg-dim" data-testid="login-recovery-warning">
                {t("auth.recoveryCodeWarning")}
              </p>
              <label className="flex flex-col gap-1 text-xs text-fg-dim">
                {t("auth.recoveryCode")}
                <Input value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)}
                  autoComplete="one-time-code" autoFocus disabled={busy}
                  placeholder={t("auth.recoveryCodePlaceholder")}
                  data-testid="login-recovery-code" />
              </label>
              <Button variant="primary" type="submit" className="w-full"
                disabled={busy || !recoveryCode.trim()} data-testid="login-recovery-submit">
                {busy && <Loader2 size={16} className="animate-spin" />}
                {t("auth.recoveryCodeSubmit")}
              </Button>
            </form>
          ) : (
            <button type="button" className="self-start text-xs underline text-fg-dim"
              onClick={() => setRecovering(true)} data-testid="login-recovery-open">
              {t("auth.recoveryCodeOpen")}
            </button>
          ))}
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
              #653③ had ruled on and fixed — on the SETTINGS panel only; the same box on this
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
          {/* #686 family A ①: the sentence names the kinds this workspace ACCEPTS. It used to say "an
              authenticator app" unconditionally — beside a button offering only a passkey when the
              stance was narrowed, so the one instruction a locked-out reader had was impossible to
              follow. `kinds` was already here, used by `accepts()` on the very next line. */}
          <p className="m-0 text-sm text-fg-dim" data-testid="login-factor-prompt">
            {t("auth.factorEnrolPrompt", { kinds: factorKindsPhrase(kinds, t, "setup") })}
          </p>
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
