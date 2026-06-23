import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Button } from "./Button";

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
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
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
            if (v) onSubmit(v);
          }}
        >
          <input
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-[var(--accent)]"
            value={value}
            autoFocus
            aria-label={label ?? t("dialogs.pageTitleLabel")}
            onChange={(e) => setValue(e.target.value)}
          />
          <DialogFooter className="mt-4">
            <Button variant="default" type="button" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" type="submit">
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
}: {
  open: boolean;
  message: string;
  onClose: () => void;
  onConfirm: () => void;
  // Defaults preserve the original delete-confirm behavior; non-destructive
  // confirms (e.g. restore a revision) pass a primary tone + their own label.
  title?: string;
  confirmLabel?: string;
  tone?: "danger" | "primary";
  confirmTestId?: string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="confirm-dialog" className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{title ?? t("dialogs.confirmTitle")}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4">
          <Button variant="default" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant={tone === "primary" ? "primary" : "danger"} type="button" data-testid={confirmTestId} onClick={onConfirm}>
            {confirmLabel ?? t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
