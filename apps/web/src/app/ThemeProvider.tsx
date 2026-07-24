import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Personal theme (Phase 3a): light / dark / system. Persisted to localStorage and
// reflected on <html data-theme> so the token CSS (styles/tokens.css) + the CSS-
// variable-driven CodeMirror theme recolor everything WITHOUT rebuilding any view.
// Default is 'system' (follows the OS via prefers-color-scheme). Branding (3c) will
// layer accent overrides on top without touching this base.
export type Theme = "light" | "dark" | "system";
const KEY = "wks.theme";
// #201: the user's PERSONAL accent, device-local (like light/dark), NOT server-stored. null = inherit
// the tenant accent. It overrides the tenant accent for this user only (never affects others).
const ACCENT_KEY = "wks.userAccent";

function load(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

function loadAccent(): string | null {
  try { return localStorage.getItem(ACCENT_KEY) || null; } catch { return null; }
}

const ThemeContext = createContext<{
  theme: Theme; setTheme: (t: Theme) => void;
  accent: string | null; setAccent: (key: string | null) => void;
}>({
  theme: "system",
  setTheme: () => {},
  accent: null,
  setAccent: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(load);
  const [accent, setAccentState] = useState<string | null>(loadAccent);

  // Reflect the choice on <html> (synchronously on first paint to avoid a flash).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // #505: a DARK print must paint the sheet dark to the paper edge, or the light reading text (--fg) is
  // faint on white paper. A dark background reaches every edge only when the page has NO @page margin (a
  // page margin is outside the page box and the root background can't paint it) — so a dark print swaps
  // print.css's @page{margin:14mm} for @page{margin:0} plus a 14mm padding on the print surface. @page
  // rules can't read <html data-theme>, so reflect the RESOLVED dark state (this is the one place that
  // resolves 'system' → OS preference) into a print-scoped stylesheet, appended last so it overrides
  // print.css. Light print keeps the even page margin untouched — strict non-regression.
  useEffect(() => {
    const ID = "wks-print-dark";
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      let el = document.getElementById(ID) as HTMLStyleElement | null;
      if (!dark) { el?.remove(); return; }
      if (!el) { el = document.createElement("style"); el.id = ID; document.head.appendChild(el); }
      el.textContent = "@media print{@page{margin:0}[data-print-root]{padding:14mm;box-sizing:border-box}}";
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [theme]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    try { localStorage.setItem(KEY, t); } catch { /* private mode — choice just won't persist */ }
  };

  const setAccent = (key: string | null) => {
    setAccentState(key);
    try { if (key) localStorage.setItem(ACCENT_KEY, key); else localStorage.removeItem(ACCENT_KEY); } catch { /* private mode */ }
  };

  return <ThemeContext.Provider value={{ theme, setTheme, accent, setAccent }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
