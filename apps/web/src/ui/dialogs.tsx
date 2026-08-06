import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { OneTimeSecret } from "./OneTimeSecret";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Button } from "./Button";
import { Input } from "./Input";

// Rename/confirm flows on shadcn Dialog (Radix: focus trap, ESC, aria, overlay).
// Controlled via `open`; testids preserved for e2e.

export function RenameDialog({
  open,
  initial,
  onClose,
  onSubmit,
  title,
  label,
  submitLabel,
  submitting = false,
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
  // #445 the dialog now stays open while a submission is in flight (it closes on success),
  // so the submit button must refuse a second press rather than fire the mutation twice.
  submitting?: boolean;
  // Optional overrides so this serves rename AND create flows (default: page rename).
  title?: string;
  label?: string;
  submitLabel?: string;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="rename-dialog" className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{title ?? t("dialogs.renamePageTitle")}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = value.trim();
            if (v && !submitting) onSubmit(v);
          }}
        >
          <Input
            value={value}
            autoFocus
            aria-label={label ?? t("dialogs.pageTitleLabel")}
            onChange={(e) => setValue(e.target.value)}
          />
          <DialogFooter className="mt-4">
            <Button variant="default" type="button" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={submitting}>
              {submitLabel ?? t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  message,
  onClose,
  onConfirm,
  title,
  confirmLabel,
  tone = "danger",
  confirmTestId = "confirm-delete",
  stacked = false,
  warning,
  typedConfirmText,
  typedConfirmLabel,
}: {
  open: boolean;
  message: string;
  onClose: () => void;
  onConfirm: () => void;
  // #246: optional extra content between the message and the buttons (e.g. a backlink warning on delete).
  warning?: ReactNode;
  // Defaults preserve the original delete-confirm behavior; non-destructive
  // confirms (e.g. restore a revision) pass a primary tone + their own label.
  title?: string;
  confirmLabel?: string;
  tone?: "danger" | "primary";
  confirmTestId?: string;
  // When shown OVER another open dialog (e.g. the permissions dialog), raise the
  // overlay + content above it (default z-50) so it isn't drawn behind the base dialog.
  stacked?: boolean;
  // #437 / ADR-167: typed confirmation for the IRREVERSIBLE path — the confirm button stays
  // disabled until the user types this exact text (e.g. the page title). Resets on open.
  typedConfirmText?: string;
  typedConfirmLabel?: string;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  useEffect(() => { if (open) setTyped(""); }, [open]);
  const typedOk = !typedConfirmText || typed === typedConfirmText;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="confirm-dialog"
        className={`sm:max-w-[400px]${stacked ? " z-[60]" : ""}`}
        overlayClassName={stacked ? "z-[60]" : undefined}>
        <DialogHeader>
          <DialogTitle>{title ?? t("dialogs.confirmTitle")}</DialogTitle>
          {/* #617: the message is composed by 18 different callers, and any of them may interpolate a
              string with no break opportunity — a sub, a token, a URL, a title typed without spaces.
              Without this the text simply does not wrap and walks out through the right edge of the
              dialog (measured: 115px past it). Fixed in the CONTAINER so every caller is covered at
              once; `anywhere` rather than `break-all` so ordinary prose still breaks at spaces. */}
          <DialogDescription data-testid="confirm-message" className="[overflow-wrap:anywhere]">{message}</DialogDescription>
        </DialogHeader>
        {warning}
        {typedConfirmText != null && (
          <div className="mt-2 flex flex-col gap-1.5">
            <span className="text-sm text-fg-dim">{typedConfirmLabel ?? t("dialogs.typeToConfirm", { text: typedConfirmText })}</span>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="typed-confirm-input" placeholder={typedConfirmText} />
          </div>
        )}
        <DialogFooter className="mt-4">
          <Button variant="default" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant={tone === "primary" ? "primary" : "danger"} type="button" data-testid={confirmTestId} disabled={!typedOk} onClick={onConfirm}>
            {confirmLabel ?? t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

//
// The password-setup link was produced by a row's ⋯ menu and rendered under the invite FORM, most of a
// screen away — because it shared `lastLink` with the invite flow, where "operate the form, read the
// result beneath it" is the natural shape. From a row it is not: the reader looks at the row, and the
// answer appears somewhere they are not.
//
// A modal is what the ruling suggested, and it is the one presentation that does not depend on where the
// action was taken. What it contains is the SHARED box (`OneTimeSecret`) rather than a third spelling of
// it, so a link that can only be shown once looks the same whichever of the three made it.
export function SecretDialog({ open, title, secret, note, onClose, testId }: {
  open: boolean;
  /** what kind of secret this is — an invitation and a password entrance are not interchangeable (#606) */
  title: string;
  secret: string;
  note?: ReactNode;
  onClose: () => void;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid={testId ? `${testId}-dialog` : "secret-dialog"} className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <OneTimeSecret title={t("members.copyOnce")} value={secret} note={note} testId={testId} />
        <DialogFooter>
          <Button variant="primary" data-testid="secret-dialog-done" onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
