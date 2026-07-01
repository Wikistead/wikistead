import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// #190 / ADR-090: personal BODY-font override (device-local, mirrors ThemeProvider). Resolution order
// is user > locale-default: this inline override on <html> beats the :root / :lang(en) locale defaults
// (tokens.css). "locale" (default) clears the override so the locale default applies (JP=UDEV Gothic,
// EN=Wikistead Mono). The other choices force a face regardless of locale. Token-driven: only the
// --font-body CSS variable changes; no view rebuild. (The code face is a single vendored font, so
// there is no per-user code picker in v1; --font-code stays fixed.)
export type FontBody = "locale" | "udev" | "mono";
const KEY = "wks.fontBody";

// The literal stacks a forced choice writes to --font-body (kept in sync with tokens.css defaults).
const STACKS: Record<Exclude<FontBody, "locale">, string> = {
  udev: '"UDEV Gothic", ui-monospace, SFMono-Regular, Menlo, monospace',
  mono: '"Wikistead Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

function load(): FontBody {
  try {
    const v = localStorage.getItem(KEY);
    return v === "udev" || v === "mono" || v === "locale" ? v : "locale";
  } catch {
    return "locale";
  }
}

// Apply a body-font choice to <html>: a forced face writes an inline --font-body (beating the locale
// default); "locale" clears it so the :root / :lang default applies. Exported for unit testing.
export function applyFontBody(pref: FontBody) {
  const root = document.documentElement;
  if (pref === "locale") root.style.removeProperty("--font-body"); // fall back to the locale default
  else root.style.setProperty("--font-body", STACKS[pref]);
}

const FontContext = createContext<{ fontBody: FontBody; setFontBody: (f: FontBody) => void }>({
  fontBody: "locale",
  setFontBody: () => {},
});

export function FontProvider({ children }: { children: ReactNode }) {
  const [fontBody, setState] = useState<FontBody>(load);

  useEffect(() => { applyFontBody(fontBody); }, [fontBody]);

  const setFontBody = (f: FontBody) => {
    setState(f);
    try { localStorage.setItem(KEY, f); } catch { /* private mode — choice just won't persist */ }
  };

  return <FontContext.Provider value={{ fontBody, setFontBody }}>{children}</FontContext.Provider>;
}

export function useFontBody() {
  return useContext(FontContext);
}
