import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// #633 / ADR-217: the font picker is gone, and one toggle stands where it was.
//
// It used to offer four faces by NAME (`udev` / `mono` / `sans` / `locale`). A name is a promise about
// glyphs, and it becomes a lie the day this product grows Korean or Chinese: the chosen face has none,
// the browser substitutes silently, and the setting says something untrue about what is on screen. So
// the names go, and what remains is the only question a reader can actually answer for themselves —
// whether turning vim on should also switch the prose to the monospace column grid.
//
// Default ON (user ruling): somebody who turns vim on gets the grid without being asked. The
// toggle exists for the reader who wants vim's keys and not its typography.
//
// The mechanism is one attribute on <html>, not a face: `data-vim-mono` is present when vim is on AND
// this is kept. tokens.css decides what that MEANS (which surfaces, and which fallback), so the rule
// about print and public pages lives beside the rule about the editor rather than in two languages.
const KEY = "wks.vimMono";
// #190's key, now unread. Left in place rather than deleted: a reader who once chose a face has that
// choice in their browser, and clearing it from here would be this code reaching into storage it no
// longer owns to erase something nobody asked it to. It is inert — nothing reads it.
export const RETIRED_FONT_KEY = "wks.fontBody";

function load(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? true : v === "1"; // absent = never chosen = the default, which is on
  } catch {
    return true; // private mode: the default, not an error state
  }
}

/**
 * Put (or remove) the marker that makes vim's typography apply. Exported for tests and for the editor,
 * which knows whether vim is on.
 */
export function applyVimMono(on: boolean): void {
  const root = document.documentElement;
  if (on) root.setAttribute("data-vim-mono", "");
  else root.removeAttribute("data-vim-mono");
}

const FontContext = createContext<{ vimMono: boolean; setVimMono: (v: boolean) => void }>({
  vimMono: true,
  setVimMono: () => {},
});

export function FontProvider({ children }: { children: ReactNode }) {
  const [vimMono, setState] = useState<boolean>(load);

  // The attribute is only half the condition — the editor adds the other half (is vim on) by calling
  // `applyVimMono` when it toggles. Here it is mirrored so a change in settings takes effect at once
  // for a reader who already has vim on.
  useEffect(() => {
    if (!vimMono) applyVimMono(false);
    else if (document.documentElement.hasAttribute("data-vim-on")) applyVimMono(true);
  }, [vimMono]);

  const setVimMono = (v: boolean) => {
    setState(v);
    try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* private mode — it just won't persist */ }
  };

  return <FontContext.Provider value={{ vimMono, setVimMono }}>{children}</FontContext.Provider>;
}

export function useVimMono() {
  return useContext(FontContext);
}

/** Whether the reader has kept the toggle. Read outside React (the editor's vim toggle). */
export function vimMonoEnabled(): boolean {
  return load();
}
