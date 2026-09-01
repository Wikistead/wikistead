import { toast } from "sonner";
import { Toaster } from "../components/ui/sonner";

// App-wide toasts on Sonner (shadcn). Sonner stacks natively — newer toasts sit in
// front, older ones peek behind — so the stacking is correct without custom CSS.
// Mount <Toasts/> once at the app root; fire from anywhere via `notify` (pass
// already-translated strings). API preserved from the previous Ark-based helper.
export const notify = {
  success: (title: string) => toast.success(title),
  error: (title: string) => toast.error(title),
  info: (title: string) => toast(title),
  // A toast for a STATE rather than an EVENT: it stays until the reader dismisses it (the
  // close button) or the caller calls `dismiss`, instead of the default few seconds. Passing
  // the same `id` again updates that toast in place — Sonner keys on `id` — so a state that
  // moves through several phases (e.g. connecting → syncing) never stacks duplicates (#978).
  // Warning-typed (#978 owner ruling, 2026-09-02): the old band carried the danger accent, and the
  // normal-typed toast that replaced it read as an ordinary notice. The Toaster's richColors tints
  // warning toasts amber, so the "not being saved" state is visibly a warning again.
  persistent: (id: string, title: string, description?: string) =>
    toast.warning(title, { id, duration: Infinity, description }),
  dismiss: (id: string) => toast.dismiss(id),
};

export function Toasts() {
  // bottom-center: keeps toasts clear of the bottom-RIGHT floating action buttons (they
  // used to block the Edit/Publish group). Other Toaster defaults (close button, per-type
  // colors, opaque bg) live in components/ui/sonner.tsx.
  return <Toaster position="bottom-center" />;
}
