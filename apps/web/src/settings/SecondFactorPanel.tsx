import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, Trash2 } from "lucide-react"; // #544: an icon component, never a text glyph
import { Button, IconButton } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { Input } from "../ui/Input";
import { ListRow, ListBox } from "../ui/list-rows"; // #639: the one list shape the admin screens share
import { OneTimeSecret } from "../ui/OneTimeSecret";
import { QrCode } from "../ui/QrCode"; // #653 (ruling): qr-creator, MIT, no dependencies
import { notify } from "../ui/toast";
import { useMyFactors, useStartTotpEnrolment, useConfirmFactor, useRemoveFactor } from "../data/queries";
import { ApiError } from "../data/apiClient";

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
      notify.success(t("account.factorAdded"));
    } catch {
      notify.error(t("account.factorCodeWrong"));
    }
  };

  const onRemove = async (id: string, confirmed: boolean) => {
    try {
      await remove.mutateAsync({ factorId: id, code: confirmed ? removing?.code.trim() : undefined });
      setRemoving(null);
      notify.success(t("account.factorRemoved"));
    } catch {
      notify.error(t("account.factorCodeWrong"));
    }
  };

  const list = factors.data ?? [];

  return (
    <div data-testid="second-factor-panel">
      <p className="mb-2 text-xs text-fg-dim">{t("account.factorsHint")}</p>

      {list.length > 0 && (
        <ListBox className="mb-3" data-testid="factor-list">
          {list.map((f) => (
            <ListRow key={f.id} data-testid="factor-row">
              <ShieldCheck size={16} aria-hidden className="text-fg-dim" />
              <span className="min-w-0 flex-1 truncate" data-testid="factor-label">
                {f.label || t("account.factorUnnamed")}
                {/* #653①: an unconfirmed row IS shown, and says what it is. The cap counts these,
                    so hiding them made "you can create it, you cannot see it, and because you cannot
                    see it you cannot delete it" — three closed tabs and the account could never enrol
                    again. It is not called a factor; it is called unfinished. */}
                {!f.confirmedAt && (
                  <span className="ml-2 text-xs text-fg-dim" data-testid="factor-pending-mark">
                    {t("account.factorUnfinished")}
                  </span>
                )}
              </span>
              {removing?.id === f.id ? (
                <>
                  {/* The code is asked for HERE rather than in a dialog, because #660 wants possession
                      and the reader has to fetch it from the device they are giving up. */}
                  <Input value={removing.code} onChange={(e) => setRemoving({ id: f.id, code: e.target.value })}
                    placeholder={t("account.factorCodePlaceholder")} aria-label={t("account.factorCode")}
                    inputMode="numeric" data-testid="factor-remove-code" />
                  <Button variant="danger" size="sm" data-testid="factor-remove-confirm"
                    disabled={!removing.code.trim()} onClick={() => void onRemove(f.id, true)}>
                    {t("account.factorRemove")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
                </>
              ) : (
                <IconButton aria-label={t("account.factorRemove")} data-testid="factor-remove"
                  onClick={() => (f.confirmedAt
                    // possession is only asked for something that guards anything (#660)
                    ? setRemoving({ id: f.id, code: "" })
                    : void onRemove(f.id, false))}>
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
          <Button variant="primary" disabled={startEnrolment.isPending || atLimit}
            onClick={() => void onStart()} data-testid="factor-add">{t("account.factorAdd")}</Button>
        </FormRow>
      )}
    </div>
  );
}
