import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react"; // #544: an icon component, never a text glyph
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { OneTimeSecret } from "../ui/OneTimeSecret";
import { notify } from "../ui/toast";
import { ApiError } from "../data/apiClient";
import { startAuthentication } from "@simplewebauthn/browser";
import {
  useMyRecoveryCodes, useMintRecoveryCodes, useRecoveryReauthChallenge, useMyFactors,
} from "../data/queries";

// #650 / ADR-226: the member's own recovery codes. SELF-SCOPE like the factor panel beside it — every
// call is keyed to the session's subject by the server, and there is no administrator route to mint
// somebody else's set (a set minted by another person is a credential its holder never saw).
//
// WHAT THIS SCREEN NEVER SHOWS: a code, after the moment it was made. The plaintext exists once, in the
// mint response, and the list afterwards is a count and a date. That is not a limitation to work around
// — it is the property that makes "keep these somewhere safe" mean anything.
//
// NO MEMBER COUNT, NO ROLE, anywhere in this file. The ruling on ADR-226 rev1 removed the predicate that
// made codes depend on the shape of the workspace, and a screen that hid the button for an ordinary
// member would put it back on the only surface that matters to the person locked out.
export function RecoveryCodesPanel() {
  const { t } = useTranslation();
  const set = useMyRecoveryCodes();
  const factors = useMyFactors();
  const mint = useMintRecoveryCodes();
  const challenge = useRecoveryReauthChallenge();

  /** the set just minted — held HERE and never in the query cache, so leaving the screen loses it */
  const [minted, setMinted] = useState<string[] | null>(null);
  /** the re-authentication being asked for, and what has been typed into it */
  const [proving, setProving] = useState<null | { code: string; password: string }>(null);

  const remaining = set.data?.remaining ?? 0;
  const enabled = set.data?.enabled !== false;
  // ADR-226 §2's ONE precondition: something to recover. A member with no confirmed factor is never
  // asked for one at the door, so a set would be ten strings that do nothing — and the first thing one
  // of them WOULD do is wipe the factor they enrol next. The server refuses this too (409); asking here
  // as well is the two-layer rule, not a second decision — the UI is convenience, the server is the fort.
  const hasFactor = (factors.data?.factors ?? []).some((f) => f.confirmedAt);
  // Which proofs this member can actually offer, so the form asks for what they have rather than
  // listing every mechanism the server accepts (#606: a control whose only outcome is a refusal).
  const hasTotp = (factors.data?.factors ?? []).some((f) => f.confirmedAt && f.kind === "totp");
  const hasPasskey = (factors.data?.factors ?? []).some((f) => f.confirmedAt && f.kind === "passkey");

  const afterMint = (codes: string[]) => {
    setMinted(codes);
    setProving(null);
    notify.success(t("account.recoveryMinted"));
  };

  const failed = (e: unknown) => {
    // `code`, not the message — matching on prose breaks the day a sentence is reworded (#578).
    if (e instanceof ApiError && e.code === "reauth_required") return notify.error(t("account.recoveryReauthFailed"));
    if (e instanceof ApiError && e.code === "recovery_no_factors") return notify.error(t("account.recoveryNeedsFactor"));
    if (e instanceof ApiError && e.code === "recovery_disabled") return notify.error(t("account.recoveryDisabled"));
    notify.error(t("account.recoveryMintFailed"));
  };

  const submitProof = async () => {
    if (!proving) return;
    try {
      const res = await mint.mutateAsync({
        ...(proving.code.trim() ? { code: proving.code.trim() } : {}),
        ...(proving.password ? { password: proving.password } : {}),
      });
      afterMint(res?.codes ?? []);
    } catch (e) { failed(e); }
  };

  /** Prove with a key instead: the challenge is a write, then the assertion goes back with the mint. */
  const proveWithPasskey = async () => {
    try {
      const started = await challenge.mutateAsync();
      if (!started?.options) return notify.error(t("account.recoveryReauthFailed"));
      const assertion = await startAuthentication({ optionsJSON: started.options as never });
      afterMint((await mint.mutateAsync({ passkey: assertion }))?.codes ?? []);
    } catch (e) {
      // A dismissed key prompt lands here too, and it is not a server refusal — but it is also not
      // something to explain at length: the reader cancelled, and the button is still there.
      if (e instanceof ApiError) return failed(e);
      notify.error(t("account.recoveryReauthFailed"));
    }
  };

  return (
    <div className="mt-6" data-testid="recovery-codes-panel">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <KeyRound size={14} aria-hidden />
        {t("account.recoveryTitle")}
      </h3>
      <p className="mb-2 text-xs text-fg-dim" data-testid="recovery-explainer">{t("account.recoveryExplainer")}</p>

      {!enabled ? (
        /* The operator turned it off. Said plainly, with no button: a control that is certain to be
           refused is worse than none, and the reader's next move is to ask an administrator, not to
           press harder. */
        <p className="text-xs text-fg-dim" data-testid="recovery-disabled">{t("account.recoveryDisabled")}</p>
      ) : minted ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="recovery-minted">
          {/* The same one-time box the enrolment secret and a password link use. It already says
              "shown once, copy it now", so this note says the one thing it does not: where they go. */}
          <OneTimeSecret value={minted.join("\n")} testId="recovery-codes"
            note={t("account.recoveryStoreNote")} />
          <p className="m-0 text-xs text-fg-dim">{t("account.recoveryOneShotNote", { count: minted.length })}</p>
          <Button variant="default" className="self-start" data-testid="recovery-done"
            onClick={() => setMinted(null)}>{t("account.recoverySaved")}</Button>
        </div>
      ) : (
        <>
          <p className="mb-2 text-xs" data-testid="recovery-status">
            {remaining > 0 ? t("account.recoveryRemaining", { count: remaining }) : t("account.recoveryNone")}
          </p>
          {!hasFactor ? (
            <p className="text-xs text-fg-dim" data-testid="recovery-needs-factor">{t("account.recoveryNeedsFactor")}</p>
          ) : proving ? (
            <form className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="recovery-reauth"
              onSubmit={(e) => { e.preventDefault(); void submitProof(); }}>
              {/* ADR-226 §4: a stolen session must not be able to mint codes — that would BE the factor
                  bypass this feature is careful not to be. So the account proves itself again, with
                  whichever of the three proofs the member actually holds. */}
              <p className="m-0 text-xs text-fg-dim">{t("account.recoveryReauthPrompt")}</p>
              {hasTotp && (
                <Input value={proving.code} onChange={(e) => setProving({ ...proving, code: e.target.value })}
                  inputMode="numeric" autoComplete="one-time-code" placeholder={t("account.factorCodePlaceholder")}
                  aria-label={t("account.factorCode")} data-testid="recovery-reauth-code" />
              )}
              <Input type="password" value={proving.password} autoComplete="current-password"
                onChange={(e) => setProving({ ...proving, password: e.target.value })}
                placeholder={t("account.recoveryReauthPassword")} aria-label={t("account.recoveryReauthPassword")}
                data-testid="recovery-reauth-password" />
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" type="submit" data-testid="recovery-reauth-submit"
                  disabled={mint.isPending || (!proving.code.trim() && !proving.password)}>
                  {t("account.recoveryMint")}
                </Button>
                {hasPasskey && (
                  <Button variant="default" type="button" data-testid="recovery-reauth-passkey"
                    disabled={mint.isPending || challenge.isPending} onClick={() => void proveWithPasskey()}>
                    {t("account.recoveryReauthPasskey")}
                  </Button>
                )}
                <Button variant="ghost" type="button" onClick={() => setProving(null)}>{t("common.cancel")}</Button>
              </div>
            </form>
          ) : (
            <>
              {/* Re-minting is the SAME button, deliberately. It is one act — "give me a set that
                  works" — and a separate "regenerate" would suggest the old codes survive it. They do
                  not: the previous set is revoked as the new one is written. */}
              <Button variant={remaining > 0 ? "default" : "primary"} data-testid="recovery-mint"
                onClick={() => setProving({ code: "", password: "" })}>
                {remaining > 0 ? t("account.recoveryRemint") : t("account.recoveryMint")}
              </Button>
              {remaining > 0 && (
                <p className="mt-1 text-xs text-fg-dim" data-testid="recovery-remint-note">
                  {t("account.recoveryRemintNote")}
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
