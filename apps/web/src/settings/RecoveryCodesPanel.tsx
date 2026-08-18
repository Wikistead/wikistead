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
// #650/(user, at the screen): 123456
//
// The form had `placeholder` and `aria-label` and no visible label at all, so the screen showed a box
// containing "123456" and a box containing — which reads as two boxes to fill, when in fact
// ANY ONE of three proofs is enough. And a placeholder is gone the moment a finger touches the key, so
// the one moment a person wants to check what a field wants is the moment the answer disappears.
//
// SEPARATE from the panel so it can be RENDERED in a test. The labels are the whole fix; a pin that
// grepped the source for `<label` would stay green against a label rendered off-screen or never
// mounted, and this is the second time these five items have had to be asked for.
export function RecoveryReauthForm({ proving, onChange, hasTotp, hasPasskey, busy, passkeyBusy, onSubmit, onPasskey, onCancel }: {
  proving: { code: string; password: string };
  onChange: (next: { code: string; password: string }) => void;
  hasTotp: boolean;
  hasPasskey: boolean;
  busy: boolean;
  passkeyBusy: boolean;
  onSubmit: () => void;
  onPasskey: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <form className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="recovery-reauth"
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      {/* ADR-226 §4: a stolen session must not be able to mint codes — that would BE the factor
          bypass this feature is careful not to be. So the account proves itself again, with
          whichever of the three proofs the member actually holds. The prompt says "any one of these"
          because the form cannot: two fields stacked above two buttons look like a checklist. */}
      <p className="m-0 text-xs text-fg-dim" data-testid="recovery-reauth-prompt">{t("account.recoveryReauthPrompt")}</p>
      {hasTotp && (
        <label className="flex flex-col gap-1 text-xs text-fg-dim">
          {t("account.recoveryReauthTotp")}
          <Input value={proving.code} onChange={(e) => onChange({ ...proving, code: e.target.value })}
            inputMode="numeric" autoComplete="one-time-code" placeholder={t("account.factorCodePlaceholder")}
            data-testid="recovery-reauth-code" />
        </label>
      )}
      <label className="flex flex-col gap-1 text-xs text-fg-dim">
        {t("account.recoveryReauthPassword")}
        {/* no placeholder: it would repeat the label a centimetre lower and then vanish on the first
            keystroke. "123456" above earns its place as an EXAMPLE of a shape; does not. */}
        <Input type="password" value={proving.password} autoComplete="current-password"
          onChange={(e) => onChange({ ...proving, password: e.target.value })}
          data-testid="recovery-reauth-password" />
      </label>
      {/* Both buttons say CREATE. They were and — two verbs for
          one act, which left the reader unable to tell whether the passkey button finished the job or
          only unlocked the form (it finishes it). Three entrances, one destination, said once. */}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" type="submit" data-testid="recovery-reauth-submit"
          disabled={busy || (!proving.code.trim() && !proving.password)}>
          {t("account.recoveryMint")}
        </Button>
        {hasPasskey && (
          <Button variant="default" type="button" data-testid="recovery-reauth-passkey"
            disabled={busy || passkeyBusy} onClick={onPasskey}>
            {t("account.recoveryReauthPasskey")}
          </Button>
        )}
        <Button variant="ghost" type="button" onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
    </form>
  );
}

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
          {/* The same one-time box the enrolment secret and a password link use, and NOTHING under it.
              #650/(user, at the screen): two notes used to sit here — where to keep them,
              and "ten codes, each works once". The box already says "shown once, copy it now"; the count
              is the ten lines the reader is looking at; "each works once" is the first sentence of the
              explainer above. The reader's one job at this moment is to copy, and every sentence added
              here is a hand stopped mid-copy. Where NOT to keep them belongs above, before they exist. */}
          <OneTimeSecret value={minted.join("\n")} testId="recovery-codes" />
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
            <RecoveryReauthForm proving={proving} onChange={setProving} hasTotp={hasTotp} hasPasskey={hasPasskey}
              busy={mint.isPending} passkeyBusy={challenge.isPending}
              onSubmit={() => void submitProof()} onPasskey={() => void proveWithPasskey()}
              onCancel={() => setProving(null)} />
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
