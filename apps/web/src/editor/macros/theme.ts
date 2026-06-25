import type { MacroTheme } from "./registry";

// Resolve the active theme for a macro render. Read from <html data-theme> (set by
// ThemeProvider); "system"/unset falls back to the OS preference. Shared by the live
// preview widget and the modal so a macro always gets a concrete light/dark.
export function currentMacroTheme(): MacroTheme {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return "dark";
  if (t === "light") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
