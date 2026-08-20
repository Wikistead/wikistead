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
import { browserCanUseFactorKind, proofBeginsOnChoice } from "./factor-kind"; // #686: one predicate for "can this window do it"

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
// #650/ (user, at the screen): could not tell what to type into the fields — only a code
// example and a password placeholder showed — and then, still, could not tell what goes where or what
// to press.
// The fields carried a `placeholder` and an `aria-label` and no visible label, so any one of three proofs
// read as two boxes to fill — and a placeholder is gone the moment a finger touches the key.
//
// #650 (user, at the same screen): offer the usable auth methods as buttons — press one to
// verify, then create. The round before that answered the labels but left the SHAPE: two fields stacked
// above two buttons, with a sentence underneath explaining that any one of them is enough. A sentence
// that exists to explain a layout is a layout that failed, and the previous version's own comment said so.
//
// It was also lying to some people. The code field and the passkey button were conditional on holding
// those factors, but the password field was drawn unconditionally — so a member who signs in through an
// IdP, or whose password entrance an administrator removed (which THIS feature is wired to do), was shown
// a box they can never fill directly under "any one of these is enough".
//
// So: PICK A METHOD, then prove. The list contains only what this member actually holds, which makes the
// sentence unnecessary — the shape says it. One method means no list at all: a menu with one item is a
// keystroke charged for nothing.
//
// SEPARATE from the panel so it can be RENDERED in a test. The whole fix is what a person sees; a pin that
// grepped the source would stay green against a label rendered off-screen or a branch never mounted, and
// these items have now had to be asked for three times.

/** The ways a member can prove it is them here. Order is the order they are offered. */
export const REAUTH_METHODS = ["totp", "passkey", "password"] as const;

/**
 * What happens when the member picks a method (#745).
 *
 * Exported, and taking its effects as arguments, because the decision inside it is the one the owner
 * caught at the screen: choosing a passkey IS presenting it, and the second button that used to sit
 * behind that choice asked for a decision nobody had left to make. The rule itself belongs to the KIND
 * (`proofBeginsOnChoice`) — the door asks the same question, and these two screens have now grown the
 * same shape twice.
 */
export function pickReauthMethod(
  method: ReauthMethod | null,
  actions: { setMethod: (m: ReauthMethod | null) => void; resetProof: () => void; present: () => void },
): void {
  actions.setMethod(method);
  actions.resetProof();
  if (method && proofBeginsOnChoice(method)) actions.present();
}
export type ReauthMethod = (typeof REAUTH_METHODS)[number];

/**
 * Which proofs this member can actually offer, in the order they are offered.
 *
 * A FUNCTION, and exported, because this is the thing that was wrong: the old screen derived the factor
 * halves inline (so they came and went correctly) and simply drew the password box, which is not
 * derivable from anything the screen can read. Written as one place with one set of inputs, the omission
 * has somewhere to be caught — and the pin can drop `hasPassword` and watch it go red.
 */
export function proofsHeld(args: {
  factors: readonly { kind: string; confirmedAt: string | null }[];
  /** the server's answer; a password entrance is not a factor and is in no list this screen can read */
  hasPassword: boolean;
  /** whether THIS window can do WebAuthn at all (#686's shared predicate, asked by the caller) */
  webauthn: boolean;
}): ReauthMethod[] {
  const confirmed = (kind: string) => args.factors.some((f) => f.confirmedAt && f.kind === kind);
  const held: Record<ReauthMethod, boolean> = {
    totp: confirmed("totp"),
    // A key this member owns is no help in a window with no WebAuthn, and offering it there is the
    // refusal-only control of #606 arriving by another route.
    passkey: confirmed("passkey") && args.webauthn,
    password: args.hasPassword,
  };
  return REAUTH_METHODS.filter((m) => held[m]);
}

/**
 * Where the member starts: at the one proof they hold, or at the chooser.
 *
 * Its own function for the same reason as `proofsHeld` — measured, this was the half a pin could not
 * see. The form is handed a method and draws it, so a regression that stopped skipping the chooser
 * would leave every rendering assertion green while charging a keystroke for a decision with one answer
 * (ruling ①).
 */
export function initialMethod(methods: readonly ReauthMethod[]): ReauthMethod | null {
  return methods.length === 1 ? methods[0]! : null;
}

export function RecoveryReauthForm({
  method, methods, proving, onChange, onPick, busy, passkeyBusy, onSubmit, onPasskey, onCancel,
}: {
  /** the method being proved with, or null while the member is still choosing */
  method: ReauthMethod | null;
  /** everything this member could pick — one entry means the chooser is skipped entirely */
  methods: ReauthMethod[];
  proving: { code: string; password: string };
  onChange: (next: { code: string; password: string }) => void;
  onPick: (m: ReauthMethod | null) => void;
  busy: boolean;
  passkeyBusy: boolean;
  onSubmit: () => void;
  onPasskey: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const NAME: Record<ReauthMethod, string> = {
    totp: t("account.recoveryReauthTotp"),
    passkey: t("account.recoveryReauthPasskeyName"),
    password: t("account.recoveryReauthPassword"),
  };
  // Only offer the way back when there was a fork. Where one method exists the member never chose, so
  // "use a different method" would point at a screen they have not seen.
  const canGoBack = methods.length > 1;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="recovery-reauth">
      <p className="m-0 text-xs text-fg-dim" data-testid="recovery-reauth-prompt">{t("account.recoveryReauthPrompt")}</p>

      {method === null ? (
        // The chooser. Nothing is typed here — the point is that the reader picks one thing, and what
        // they can pick is exactly what they hold.
        <div className="flex flex-wrap gap-2" data-testid="recovery-reauth-choices">
          {methods.map((m, i) => (
            <Button key={m} variant={i === 0 ? "primary" : "default"} type="button"
              data-testid={`recovery-reauth-choose-${m}`} onClick={() => onPick(m)}>
              {NAME[m]}
            </Button>
          ))}
          <Button variant="ghost" type="button" onClick={onCancel}>{t("common.cancel")}</Button>
        </div>
      ) : method === "passkey" ? (
        // A passkey is a browser ceremony, not something to type — which is why it was a button in the
        // old form too. That part was never the problem; standing it beside two text boxes was.
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" type="button" data-testid="recovery-reauth-passkey"
            disabled={busy || passkeyBusy} onClick={onPasskey}>
            {t("account.recoveryReauthPasskey")}
          </Button>
          {canGoBack && (
            <Button variant="ghost" type="button" data-testid="recovery-reauth-back"
              onClick={() => onPick(null)}>{t("account.recoveryReauthOther")}</Button>
          )}
          <Button variant="ghost" type="button" onClick={onCancel}>{t("common.cancel")}</Button>
        </div>
      ) : (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
          {/* The visible label stays — it is the fix, and it is still the only thing naming the
              box once a finger has cleared the placeholder away. */}
          <label className="flex flex-col gap-1 text-xs text-fg-dim">
            {NAME[method]}
            {method === "totp" ? (
              <Input value={proving.code} onChange={(e) => onChange({ ...proving, code: e.target.value })}
                inputMode="numeric" autoComplete="one-time-code" autoFocus
                placeholder={t("account.factorCodePlaceholder")} data-testid="recovery-reauth-code" />
            ) : (
              // no placeholder: it would repeat the label a centimetre lower and then vanish on the
              // first keystroke. "123456" above earns its place as an EXAMPLE of a shape; a plain
              // "password" placeholder does not.
              <Input type="password" value={proving.password} autoComplete="current-password" autoFocus
                onChange={(e) => onChange({ ...proving, password: e.target.value })}
                data-testid="recovery-reauth-password" />
            )}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" type="submit" data-testid="recovery-reauth-submit"
              disabled={busy || (method === "totp" ? !proving.code.trim() : !proving.password)}>
              {t("account.recoveryMint")}
            </Button>
            {canGoBack && (
              <Button variant="ghost" type="button" data-testid="recovery-reauth-back"
                onClick={() => onPick(null)}>{t("account.recoveryReauthOther")}</Button>
            )}
            <Button variant="ghost" type="button" onClick={onCancel}>{t("common.cancel")}</Button>
          </div>
        </form>
      )}
    </div>
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
  /** which proof the member picked; null while the chooser is showing */
  const [method, setMethod] = useState<ReauthMethod | null>(null);

  const remaining = set.data?.remaining ?? 0;
  const enabled = set.data?.enabled !== false;
  // ADR-226 §2's ONE precondition: something to recover. A member with no confirmed factor is never
  // asked for one at the door, so a set would be ten strings that do nothing — and the first thing one
  // of them WOULD do is wipe the factor they enrol next. The server refuses this too (409); asking here
  // as well is the two-layer rule, not a second decision — the UI is convenience, the server is the fort.
  const hasFactor = (factors.data?.factors ?? []).some((f) => f.confirmedAt);
  // Which proofs this member can actually offer, so the form asks for what they have rather than
  // listing every mechanism the server accepts (#606: a control whose only outcome is a refusal).
  //
  // `passkey` also asks the BROWSER, through the shared predicate the rest of the product uses (#686):
  // a key this member owns is no help in a window that has no WebAuthn, and offering it there is the
  // same refusal-only control by another route.
  const methods = proofsHeld({
    factors: factors.data?.factors ?? [],
    // NOT derivable here: a password entrance is not a factor and is in no list this screen can read.
    // The server answers it on the set status (#650).
    hasPassword: set.data?.hasPassword === true,
    webauthn: browserCanUseFactorKind("passkey"),
  });
  const onlyMethod = initialMethod(methods);

  const afterMint = (codes: string[]) => {
    setMinted(codes);
    setProving(null);
    setMethod(null);
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
      // Only the proof that was CHOSEN goes up. Sending whatever happens to be in state would let a
      // half-typed code ride along with a password and decide, on the server, which one was meant.
      const res = await mint.mutateAsync(
        method === "totp" ? { code: proving.code.trim() }
        : method === "password" ? { password: proving.password }
        : {},
      );
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
              #650/ (user, at the screen): two notes used to sit here — where to keep them,
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
          ) : methods.length === 0 ? (
            /* Reachable, and a dead end if it is not caught here: a member whose only factor is a key,
               with no password entrance, in a window that cannot do WebAuthn. They hold something to
               recover, so the button above would show — and open a chooser with nothing in it. Saying
               so is the same ruling the door follows when nothing it accepts can be presented (#672 ③):
               the lock-out is accepted, but it must be legible rather than an empty panel. */
            <p className="text-xs text-fg-dim" data-testid="recovery-no-proof">{t("account.recoveryNoProof")}</p>
          ) : proving ? (
            <RecoveryReauthForm method={method} methods={methods} proving={proving} onChange={setProving}
              onPick={(m) => pickReauthMethod(m, {
                setMethod, resetProof: () => setProving({ code: "", password: "" }), present: () => void proveWithPasskey(),
              })}
              busy={mint.isPending} passkeyBusy={challenge.isPending}
              onSubmit={() => void submitProof()} onPasskey={() => void proveWithPasskey()}
              onCancel={() => { setProving(null); setMethod(null); }} />
          ) : (
            <>
              {/* Re-minting is the SAME button, deliberately. It is one act — "give me a set that
                  works" — and a separate "regenerate" would suggest the old codes survive it. They do
                  not: the previous set is revoked as the new one is written. */}
              <Button variant={remaining > 0 ? "default" : "primary"} data-testid="recovery-mint"
                onClick={() => { setProving({ code: "", password: "" }); setMethod(onlyMethod); }}>
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
