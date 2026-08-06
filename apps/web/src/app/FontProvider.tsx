import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// #633 / ADR-217: the font picker is gone, and one toggle stands where it was.
//
// It used to offer four faces by NAME (`udev` / `mono` / `sans` / `locale`). A name is a promise about
// glyphs, and it becomes a lie the day this product grows Korean or Chinese: the chosen face has none,
// the browser substitutes silently, and the setting says something untrue about what is on screen. So
// the names go, and what remains is the only question a reader can actually answer for themselves —
// whether turning vim on should also switch the prose to the monospace column grid.
//
// Default ON (user ruling,): somebody who turns vim on gets the grid without being asked. The
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

/**
 * Recompute the marker from all three of its inputs.
 *
 * #633(user ruling): the grid is for the time spent EDITING. Reading a page is the same document
 * surface, so the first version put it there too — and the reply was that most of the time with this
 * product is spent reading, which made "the font you cannot choose" also "the font that is harder to
 * read". vim's column alignment has nothing to align while nobody is typing.
 *
 * Three inputs and one place that combines them, because they arrive from three different owners: vim
 * from the keymap (a server profile for a member, this device for a guest), editing from the route, the
 * toggle from storage. Each writes its own marker on <html> and then asks here; nothing has to know the
 * others' state, and there is no order in which they can arrive that produces a wrong answer.
 */
export function refreshVimMono(): void {
  const root = document.documentElement;
  applyVimMono(root.hasAttribute("data-vim-on") && root.hasAttribute("data-editing") && vimMonoEnabled());
}

/** The route's half: whether an editable surface is currently mounted. */
export function reflectEditing(on: boolean): void {
  const root = document.documentElement;
  if (on) root.setAttribute("data-editing", "");
  else root.removeAttribute("data-editing");
  refreshVimMono();
}

const FontContext = createContext<{ vimMono: boolean; setVimMono: (v: boolean) => void }>({
  vimMono: true,
  setVimMono: () => {},
});

export function FontProvider({ children }: { children: ReactNode }) {
  const [vimMono, setState] = useState<boolean>(load);

  // This is one of three inputs; the route supplies the other two. Recomputed here so a change made in
  // settings takes effect at once for somebody already editing with vim on.
  useEffect(() => { refreshVimMono(); }, [vimMono]);

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
