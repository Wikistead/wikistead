import { useEffect } from "react";

// Close an in-place side panel (comments / history) on Escape — but NOT when the editor
// owns the key (vim normal mode, palette/context-menu dismiss all live under .cm-editor),
// and not if something already handled the event (e.defaultPrevented, e.g. a dialog). The
// panels are conditionally rendered, so this listener exists only while a panel is open.
// Outside-click is deliberately NOT a trigger: these panels are used while reading the
// body, so a stray click in the document must not dismiss them. Pass a stable callback.
export function useEscClose(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const active = document.activeElement as Element | null;
      if (active?.closest(".cm-editor")) return; // the editor owns Esc
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}
