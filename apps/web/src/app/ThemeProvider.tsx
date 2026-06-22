import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Personal theme (Phase 3a): light / dark / system. Persisted to localStorage and
// reflected on <html data-theme> so the token CSS (styles/tokens.css) + the CSS-
// variable-driven CodeMirror theme recolor everything WITHOUT rebuilding any view.
// Default is 'system' (follows the OS via prefers-color-scheme). Branding (3c) will
// layer accent overrides on top without touching this base.
export type Theme = "light" | "dark" | "system";
const KEY = "wks.theme";

function load(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: "system",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(load);

  // Reflect the choice on <html> (synchronously on first paint to avoid a flash).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    try { localStorage.setItem(KEY, t); } catch { /* private mode — choice just won't persist */ }
  };

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
