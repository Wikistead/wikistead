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
};

export function Toasts() {
  // bottom-center: keeps toasts clear of the bottom-RIGHT floating action buttons (they
  // used to block the Edit/Publish group). Other Toaster defaults (close button, per-type
  // colors, opaque bg) live in components/ui/sonner.tsx.
  return <Toaster position="bottom-center" />;
}
