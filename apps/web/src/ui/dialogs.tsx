import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@ark-ui/react/dialog";
import { Portal } from "@ark-ui/react/portal";
import styles from "./dialogs.module.css";

// Thin Ark Dialog wrappers (accessible: focus trap, ESC, aria) for the tree's
// rename and delete-confirm flows. Ark is the headless layer chosen in ADR-013.

export function RenameDialog({
  open,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && onClose()}>
      <Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Positioner className={styles.positioner}>
          <Dialog.Content className={styles.content} data-testid="rename-dialog">
            <Dialog.Title className={styles.title}>{t("dialogs.renamePageTitle")}</Dialog.Title>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v = value.trim();
                if (v) onSubmit(v);
              }}
            >
              <input
                className={styles.input}
                value={value}
                autoFocus
                aria-label={t("dialogs.pageTitleLabel")}
                onChange={(e) => setValue(e.target.value)}
              />
              <div className={styles.actions}>
                <button type="button" className={styles.btn} onClick={onClose}>
                  {t("common.cancel")}
                </button>
                <button type="submit" className={`${styles.btn} ${styles.primary}`}>
                  {t("common.save")}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
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
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && onClose()}>
      <Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Positioner className={styles.positioner}>
          <Dialog.Content className={styles.content} data-testid="confirm-dialog">
            <Dialog.Title className={styles.title}>{title ?? t("dialogs.confirmTitle")}</Dialog.Title>
            <Dialog.Description className={styles.message}>{message}</Dialog.Description>
            <div className={styles.actions}>
              <button type="button" className={styles.btn} onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${tone === "primary" ? styles.primary : styles.danger}`}
                data-testid={confirmTestId}
                onClick={onConfirm}
              >
                {confirmLabel ?? t("common.delete")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
