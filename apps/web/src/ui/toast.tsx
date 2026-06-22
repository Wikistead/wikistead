import { Toaster, ToastRoot, ToastTitle, ToastDescription, ToastCloseTrigger, createToaster, type CreateToasterReturn } from "@ark-ui/react/toast";
import { X } from "lucide-react";
import styles from "./toast.module.css";

// Lightweight app-wide toasts (Ark UI Toast — no new dependency). Used to confirm
// completions (publish, restore, share, permissions) and surface errors, so the UI
// gives the same feedback competitors do. Mount <Toasts/> once at the app root;
// fire from anywhere via the `notify` helper (pass already-translated strings).
export const toaster: CreateToasterReturn = createToaster({ placement: "bottom-end", overlap: true, gap: 8, max: 4 });

export const notify = {
  success: (title: string) => toaster.create({ title, type: "success", duration: 3000 }),
  error: (title: string) => toaster.create({ title, type: "error", duration: 5000 }),
  info: (title: string) => toaster.create({ title, type: "info", duration: 3000 }),
};

export function Toasts() {
  return (
    <Toaster toaster={toaster}>
      {(toast) => (
        <ToastRoot className={styles.toast} data-type={toast.type}>
          <div className={styles.body}>
            <ToastTitle className={styles.title}>{toast.title}</ToastTitle>
            {toast.description && <ToastDescription className={styles.desc}>{toast.description}</ToastDescription>}
          </div>
          <ToastCloseTrigger className={styles.close} aria-label="Dismiss"><X size={14} /></ToastCloseTrigger>
        </ToastRoot>
      )}
    </Toaster>
  );
}
