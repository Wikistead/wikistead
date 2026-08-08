import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, Trash2, Pencil } from "lucide-react"; // #544: an icon component, never a text glyph
import { Button, IconButton } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { Input } from "../ui/Input";
import { ListRow, ListBox } from "../ui/list-rows"; // #639: the one list shape the admin screens share
import { OneTimeSecret } from "../ui/OneTimeSecret";
import { QrCode } from "../ui/QrCode"; // #653 (ruling): qr-creator, MIT, no dependencies
import { notify } from "../ui/toast";
import {
  useMyFactors, useStartTotpEnrolment, useConfirmFactor, useRemoveFactor, useRemovePasskeyChallenge,
  useRenameFactor, useStartPasskeyEnrolment, useConfirmPasskey,
} from "../data/queries";
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser"; // #666: the key proves itself
import { ApiError } from "../data/apiClient";
import { classifyRemovalFailure, classifyEnrolmentFailure } from "./factor-removal-failure"; // #673 ② / #653 ③
import { factorKindName } from "./factor-kind"; // #653/ #673the one place a kind is a noun

// #653 / ADR-219: a member's own second factors. SELF-SCOPE — every call is keyed to the session's
// subject by the server, so no other member's factor is addressable from this screen.
//
// NOT here: the tenant-wide policy. It does not exist yet (#652) and its edition line is still with the
// ruling (#644), so a switch here would be a control for a rule nothing enforces.
//
// NO QR CODE YET, and this is a gap rather than an oversight. Rendering one needs an encoder and this
// repository has none; adding a dependency is a Review gate (ADR-011), so the manual-entry path — which
// every authenticator app offers and which is the only path for a reader whose camera cannot see the
// screen — ships first, and the QR is raised with its licence measurements on #653. The secret is shown
// in the same one-time box a password link uses, for the same reason: it is visible once.
export function SecondFactorPanel() {
  const { t } = useTranslation();
  const factors = useMyFactors();
  const startEnrolment = useStartTotpEnrolment();
  const confirm = useConfirmFactor();
  const remove = useRemoveFactor();
  const removeChallenge = useRemovePasskeyChallenge();
  const startPasskey = useStartPasskeyEnrolment();
  const confirmPasskey = useConfirmPasskey();
  const rename = useRenameFactor();
  // #653④: inline, because this product edits rows in the row (no extra dialog).
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);

  const [label, setLabel] = useState("");
  const [pending, setPending] = useState<{ factorId: string; secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  // Which factor is being removed, and the code being typed for it. #660 asks for possession, so the
  // row opens an input rather than a confirm dialog: there is something to enter, not merely to agree to.
  const [removing, setRemoving] = useState<{ id: string; code: string } | null>(null);
  // #653②: a PERMANENT state must not be reported as "try again". The cap is reached until
  // something is removed, and a toast that says otherwise sends the reader back to a button that will
  // refuse them again.
  const [atLimit, setAtLimit] = useState(false);

  const onStart = async () => {
    try {
      const res = await startEnrolment.mutateAsync({ label: label.trim() });
      setPending(res);
      setCode("");
    } catch (e) {
      // #657 refuses past MAX_FACTORS_PER_MEMBER with a 409. Swallowing it would leave the button
      // looking broken, which is the failure mode a silent catch always produces.
      // `code`, not the message. ApiError carries the server's own code for exactly this — matching on
      // prose would break the day the sentence is reworded, silently, back into "try again".
      if (e instanceof ApiError && e.code === "factor_limit_reached") {
        setAtLimit(true);
        notify.error(t("account.factorLimit"));
      } else {
        notify.error(t("account.factorStartFailed"));
      }
    }
  };

  const onConfirm = async () => {
    if (!pending) return;
    try {
      await confirm.mutateAsync({ factorId: pending.factorId, code: code.trim() });
      setPending(null); setLabel(""); setCode("");
      // This branch is only ever reached for an authenticator app — the passkey ceremony finishes in
      // `onAddPasskey` — so the kind is a constant here rather than a lookup.
      notify.success(t("account.factorAdded", { kind: factorKindName("totp", t) }));
    } catch (e) {
      // #686 (sweep): a SERVER FAULT is not a wrong code. #681 drew this line on four sign-in screens
      // and this one was outside that sweep — it told somebody their six digits were wrong while the
      // dependency behind the confirm was broken, which is the exact defect, one surface over.
      notify.error(e instanceof ApiError && e.status >= 500
        ? t("auth.temporarilyUnavailable") : t("account.factorCodeWrong"));
    }
  };

  /**
   * Enrol a passkey (#663's endpoints, which had no caller).
   *
   * One button, not a mode: the browser's prompt is the whole of the middle step, so there is nothing
   * for this screen to draw between starting and finishing — unlike a TOTP, where the secret has to be
   * readable while the member types a code back.
   *
   * The pending row is discarded when the prompt is dismissed. Leaving it would put an unconfirmed
   * factor in the list for a key that was never created, and the next attempt would meet the limit
   * (`discardPendingFactors` only runs on the way IN, so a cancel that leaves a row costs a slot).
   */
  const onAddPasskey = async () => {
    // #653③: asked BEFORE anything is started. A browser that cannot run the ceremony would
    // otherwise be issued a challenge it can never answer — a row against the cap of ten, bought for
    // nothing — and then told its key was at fault.
    if (!browserSupportsWebAuthn()) { notify.error(t("account.factorKeyUnsupported")); return; }
    let started: { factorId: string; options: Record<string, unknown> } | null = null;
    try {
      started = await startPasskey.mutateAsync({ label: label.trim() });
      if (!started) throw new Error("no options");
      const attestation = await startRegistration({ optionsJSON: started.options as never });
      await confirmPasskey.mutateAsync({ factorId: started.factorId, response: attestation });
      setLabel("");
      notify.success(t("account.factorAdded", { kind: factorKindName("passkey", t) }));
    } catch (e) {
      if (started) await remove.mutateAsync({ factorId: started.factorId }).catch(() => {});
      // #653③, the same shape #673 gave removal: situations whose next moves differ get
      // different sentences. Dismissing the prompt needs nothing; a duplicate key is already in the
      // list above; a cap needs one removed first. "That key did not confirm it" answers all three by
      // sending the reader to look for a fault in hardware that is working.
      switch (classifyEnrolmentFailure(e)) {
        case "limit": setAtLimit(true); return notify.error(t("account.factorLimit"));
        case "already": return notify.error(t("account.factorKeyAlready"));
        case "cancelled": return notify.info(t("account.factorKeyCancelled"));
        default: return notify.error(t("account.factorKeyFailed"));
      }
    }
  };

  /** Give up a passkey by signing with it (#666). */
  const onRemovePasskey = async (id: string) => {
    try {
      const issued = await removeChallenge.mutateAsync(id);
      // `apiFetch` types every body as nullable — a 204 carries none. Here a null body is the server
      // declining to issue one, which is the same "that did not work" as a refused assertion.
      if (!issued) throw new Error("no challenge");
      const { options } = issued;
      // The browser refuses if the key is not present, which is exactly the proof being asked for.
      const assertion = await startAuthentication({ optionsJSON: options as never });
      await remove.mutateAsync({ factorId: id, passkey: assertion });
      notify.success(t("account.factorRemoved", { kind: factorKindName("passkey", t) }));
    } catch (e) {
      // #673 ②: four situations used to share one sentence, including the two where the key was never
      // asked for. Telling somebody their key failed when the challenge route 404'd sends them looking
      // for a different key.
      switch (classifyRemovalFailure(e)) {
        case "cancelled": return notify.info(t("account.factorRemoveCancelled"));
        case "lastAdmin": return notify.error(t("account.factorLastAdmin"));
        case "key": return notify.error(t("account.factorKeyFailed"));
        default: return notify.error(t("account.factorRemoveFailed"));
      }
    }
  };

  // The kind travels WITH the id. This path removes a typed-code factor and an unconfirmed row of any
  // kind, so it cannot assume one — reading it from the row is what stops the sentence going back to
  // naming whatever kind happened to exist when it was written.
  const onRemove = async (id: string, kind: string, confirmed: boolean) => {
    try {
      await remove.mutateAsync({ factorId: id, code: confirmed ? removing?.code.trim() : undefined });
      setRemoving(null);
      notify.success(t("account.factorRemoved", { kind: factorKindName(kind, t) }));
    } catch (e) {
      // The floor (#652 / ADR-219 §4) refuses the LAST admin's factor while the policy is on, and the
      // code they typed was right. Reporting that as "your code did not match" sends them back to the
      // authenticator for another one, which is refused for the same unstated reason — a loop with no
      // exit in it.
      //
      // The TRANSLATED sentence, not the server's: `ApiError.message` is built from the status and the
      // path ("api 409 for /me/factors/…"), and the server's own prose is English only. What the code
      // carries is the FACT; the words belong to the screen.
      if (e instanceof ApiError && e.code === "last_admin_factor") {
        notify.error(t("account.factorLastAdmin"));
      } else if (e instanceof ApiError && e.status >= 500) {
        // #686 (sweep): same line as above, and as #681's. The floor case already proves this branch
        // knows how to say something other than "your code was wrong"; an outage deserves it too.
        notify.error(t("auth.temporarilyUnavailable"));
      } else {
        notify.error(t("account.factorCodeWrong"));
      }
    }
  };

  const onRename = async () => {
    if (!renaming) return;
    try {
      await rename.mutateAsync({ factorId: renaming.id, label: renaming.label.trim() });
      setRenaming(null);
      notify.success(t("account.factorRenamed"));
    } catch {
      notify.error(t("account.factorRenameFailed"));
    }
  };

  const list = factors.data?.factors ?? [];
  // #686 (ruling): the ADD buttons follow the tenant's stance. Offering "add a passkey" where
  // passkeys are not accepted invites somebody to enrol a factor that will not let them in — the row
  // then carries "does not count", which is the right answer to a question nobody should have been
  // asked. Existing rows are untouched: they stay listed and marked (#672), because taking away what
  // somebody already has is a different act from declining to add more.
  //
  // ⚠️ Convenience only. The endpoints still accept these enrolments and still mark them as not
  // counting; this hides an entrance, it does not close one (#613). If the endpoints are to refuse
  // outright that is its own change, with its own pin.
  const stance = factors.data?.stance ?? null;
  const canAdd = (kind: string) =>
    stance == null || stance === "off" || stance === "any" || stance === kind;

  // #682: the panel opens straight into the list. The line that used to sit here gave the STEPS of
  // enrolling an authenticator app — to somebody who had not started, on a screen that also enrols
  // passkeys, one line below a heading that already says what the screen is. Three faults in one
  // sentence: it named one kind of two, it repeated `factorScanHint` which appears at the moment the
  // key is on screen, and it added nothing to `factorsDesc`. Instructions belong to the operation, not
  // to the panel.
  return (
    <div data-testid="second-factor-panel">
      {list.length > 0 && (
        <ListBox className="mb-3" data-testid="factor-list">
          {list.map((f) => (
            <ListRow key={f.id} data-testid="factor-row">
              {/* #653②: `flex-none`. Without it the icon is a flex ITEM that shrinks, and opening
                  the remove-confirm state puts an Input and two Buttons in this same row — so the shield
                  quietly got narrower the moment you pressed delete. An `size={16}` on an svg is a
                  width ATTRIBUTE, which flex is free to override; only the class stops it. */}
              <ShieldCheck size={16} aria-hidden className="flex-none text-fg-dim" />
              {renaming?.id === f.id ? (
                <>
                  <Input value={renaming.label} onChange={(e) => setRenaming({ id: f.id, label: e.target.value })}
                    aria-label={t("account.factorRename")} data-testid="factor-rename-input"
                    onKeyDown={(e) => { if (e.key === "Enter") void onRename(); if (e.key === "Escape") setRenaming(null); }} />
                  <Button variant="primary" size="sm" data-testid="factor-rename-save"
                    disabled={rename.isPending} onClick={() => void onRename()}>
                    {t("account.factorRenameSave")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
                </>
              ) : (
              <span className="min-w-0 flex-1 truncate" data-testid="factor-label">
                {/* #653a row with no name is named by its KIND. The single fallback used to be
                    the word "authenticator", so a passkey enrolled without a name — which the Add
                    button allows, it sends an empty label — sat in the list calling itself an app. */}
                {f.label || factorKindName(f.kind, t)}
                {/* …and a row WITH a name says its kind beside it.asked whether to, and the
                    answer is yes for the same reason the bug happened: this list mixes kinds on
                    purpose, so a row called "Work phone" is otherwise unreadable as to which it is —
                    which matters at exactly the moment it counts, when deciding which one to remove.
                    Only when there is a label: an unnamed row IS the kind already, and saying it twice
                    is the duplication③ made this same panel fix. */}
                {f.label && (
                  <span className="ml-2 text-xs text-fg-dim" data-testid="factor-kind-mark">
                    {factorKindName(f.kind, t)}
                  </span>
                )}
                {/* #653①: an unconfirmed row IS shown, and says what it is. The cap counts these,
                    so hiding them made "you can create it, you cannot see it, and because you cannot
                    see it you cannot delete it" — three closed tabs and the account could never enrol
                    again. It is not called a factor; it is called unfinished. */}
                {!f.confirmedAt && (
                  <span className="ml-2 text-xs text-fg-dim" data-testid="factor-pending-mark">
                    {t("account.factorUnfinished")}
                  </span>
                )}
                {/* #679 / ADR-222 §3: a factor the workspace stopped accepting is KEPT — deleting it
                    would make a setting change a factor reset (ADR-219 §7) — and says it does not
                    count. Without the mark, a member who sees their authenticator listed and is
                    nevertheless asked to enrol something at sign-in has been told nothing.

                    The server decides: the answer needs the tenant's stance and the host both, and
                    reading `kind` here would be a second place holding the rule. */}
                {f.confirmedAt && f.counts === false && (
                  <span className="ml-2 rounded bg-panel-2 px-1.5 py-px text-[10px] text-[var(--warning,#b45309)]"
                    data-testid="factor-not-counted" data-tip={t("account.factorNotCountedTip")}>
                    {t("account.factorNotCounted")}
                  </span>
                )}
              </span>
              )}
              {renaming?.id !== f.id && removing?.id !== f.id && (
                <IconButton aria-label={t("account.factorRename")} data-testid="factor-rename"
                  className="flex-none" onClick={() => setRenaming({ id: f.id, label: f.label ?? "" })}>
                  <Pencil size={14} aria-hidden />
                </IconButton>
              )}
              {removing?.id === f.id ? (
                <>
                  {/* The code is asked for HERE rather than in a dialog, because #660 wants possession
                      and the reader has to fetch it from the device they are giving up. */}
                  <Input value={removing.code} onChange={(e) => setRemoving({ id: f.id, code: e.target.value })}
                    placeholder={t("account.factorCodePlaceholder")} aria-label={t("account.factorCode")}
                    inputMode="numeric" data-testid="factor-remove-code" />
                  <Button variant="danger" size="sm" data-testid="factor-remove-confirm"
                    disabled={!removing.code.trim()} onClick={() => void onRemove(f.id, f.kind, true)}>
                    {t("account.factorRemove")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
                </>
              ) : renaming?.id === f.id ? null : (
                /* #673 ①: ONE way in, whatever the row holds. Removing an authenticator app and
                   removing a key are the same act with the same consequence, and the kind decides only
                   what is asked for AFTER the click — a code to type, or the key itself. Drawing that
                   difference in the row gave one kind a small grey icon and the other a large red
                   button for the same danger, and put the method of proof ("remove with this key") in
                   the place where the ACTION belongs. Same act, same shape; the branch is below. */
                /* #673(3)(1): and red AT REST. #504 settled that a destructive entry point wears
                   the danger colour standing still — "red only on hover" is the thing that policy names
                   — and `api-key-revoke` and `invite-revoke` both do. This one bin was grey, so the
                   screen that had just been made consistent with the LIST convention (#639) was
                   inconsistent with the DANGER one. `variant="danger"` keeps the icon a bin, so ① above
                   still holds: every row still offers exactly one, identical way in. */
                <IconButton aria-label={t("account.factorRemove")} data-testid="factor-remove" className="flex-none"
                  variant="danger"
                  disabled={remove.isPending || removeChallenge.isPending}
                  onClick={() => {
                    // possession is only asked for something that guards anything (#660)
                    if (!f.confirmedAt) return void onRemove(f.id, f.kind, false);
                    if (f.kind === "passkey") return void onRemovePasskey(f.id);
                    setRemoving({ id: f.id, code: "" });
                  }}>
                  <Trash2 size={14} aria-hidden />
                </IconButton>
              )}
            </ListRow>
          ))}
        </ListBox>
      )}

      {atLimit && (
        <p className="mb-2 text-xs text-[var(--danger)]" data-testid="factor-limit-note">{t("account.factorLimit")}</p>
      )}

      {pending ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="factor-enrolling">
          <p className="text-xs text-fg-dim">{t("account.factorScanHint")}</p>
          {/* The URI the SERVER built, drawn as-is. Rebuilding it here would put the spelling of label,
              issuer, digits and period in two places, and the day they differ the QR reads one account
              while the typed key sets up another. */}
          <QrCode value={pending.uri} testId="factor-qr" />
          {/* The same box a one-time secret always uses: shown once, copyable, and saying so. */}
          {/* #653③: the box already says "shown once, copy it now" (`common.copyOnce`). The note
              says the one thing it does not — where the key goes — rather than saying it a second time
              in other words, which is #646's defect committed in the same hand that fixed it. */}
          <OneTimeSecret value={pending.secret} testId="factor-secret" grouped note={t("account.factorSecretNote")} />
          {/* The URI an authenticator would have read from a QR code, kept in the DOM so the enrolment
              can be driven and verified without one. Not shown: it contains the secret, which is
              already above, and a second copy invites pasting the wrong thing. */}
          {/* kept for the pin: what the QR was given, in a form a test can read back */}
          <span hidden data-testid="factor-uri">{pending.uri}</span>
          <FormRow>
            <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric"
              placeholder={t("account.factorCodePlaceholder")} aria-label={t("account.factorCode")}
              data-testid="factor-confirm-code" />
            <Button variant="primary" disabled={!code.trim() || confirm.isPending}
              onClick={() => void onConfirm()} data-testid="factor-confirm">{t("account.factorConfirm")}</Button>
            {/* Cancelling THROWS THE ROW AWAY, it does not merely stop looking at it. #660 lets a pending
                enrolment go without a code precisely so this is possible, and without it every abandoned
                start would count toward MAX_FACTORS_PER_MEMBER — measured: ten cancels and the account
                could no longer enrol anything, with nothing on screen to explain why. */}
            <Button variant="ghost" data-testid="factor-cancel"
              onClick={() => { void remove.mutateAsync({ factorId: pending.factorId }).catch(() => {}); setPending(null); setCode(""); }}>
              {t("common.cancel")}
            </Button>
          </FormRow>
        </div>
      ) : (
        <FormRow>
          <Input value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder={t("account.factorLabelPlaceholder")} aria-label={t("account.factorLabel")}
            data-testid="factor-label-input" />
          {canAdd("totp") && (
            <Button variant="primary" disabled={startEnrolment.isPending || atLimit}
              onClick={() => void onStart()} data-testid="factor-add">{t("account.factorAdd")}</Button>
          )}
          {/* #666 review: each label names the KIND, because what separates the two buttons is not the
              verb — one asks for an authenticator app, the other for a key this device holds. */}
          {canAdd("passkey") && (
            <Button variant={canAdd("totp") ? "default" : "primary"}
              disabled={startPasskey.isPending || confirmPasskey.isPending || atLimit}
              onClick={() => void onAddPasskey()} data-testid="factor-add-passkey">{t("account.factorAddPasskey")}</Button>
          )}
        </FormRow>
      )}
      {/* #682 (ruling): the domain note that stood here is gone. It was added by #653④ so that
          the fact would appear on a screen rather than only in an API refusal — but it changes nothing
          the reader can do: a passkey is made for the host they are already on. The person it does
          concern is an admin moving the domain, and #664 warns them inside that flow, before it runs;
          #680 refuses the move outright while passkeys are the only accepted kind. A fact that is
          structurally prevented and separately warned about does not also need saying at every
          enrolment. */}
    </div>
  );
}
