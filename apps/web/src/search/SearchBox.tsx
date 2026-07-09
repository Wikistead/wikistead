import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { useAccountSettings } from "../data/queries";
import { resolveKey, eventMatches } from "../app/keybindings";
import { SearchModal } from "./SearchModal";

// #285 / ADR-118: the header search is a TRIGGER for the search modal (one search UI — the old inline
// cmdk dropdown moved into SearchModal, which adds the preview pane + metadata). Cmd/Ctrl-K (the
// ADR-021 `search.focus` chord) opens the modal; its input carries the search-input testid, so the
// keyboard flow is: chord → modal opens → type → ↑↓/Ctrl-j/k → Enter navigates → Esc closes.
// All authz lives server-side (two-stage guard); see SearchModal for the render-side invariants.
export function SearchBox() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const focusChord = resolveKey("search.focus", useAccountSettings().data?.keybindings); // ADR-021 (default Mod-k)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // If something already handled the chord (e.g. the editor's slash palette consumes
      // it for nav while open, calling preventDefault), don't also open search.
      if (e.defaultPrevented) return;
      if (eventMatches(e, focusChord)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusChord]);

  return (
    <>
      <button
        type="button"
        data-testid="search-trigger"
        onClick={() => setOpen(true)}
        className="flex w-full max-w-xs items-center gap-2 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm text-fg-dim hover:bg-panel-2"
      >
        <Search size={14} className="shrink-0" />
        <span className="truncate">{t("search.placeholderKbd")}</span>
      </button>
      <SearchModal open={open} onOpenChange={setOpen} />
    </>
  );
}
