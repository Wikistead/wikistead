import type { MacroTheme } from "./registry";

// Resolve the active theme for a macro render. Read from <html data-theme> (set by
// ThemeProvider); "system"/unset falls back to the OS preference. Shared by the live
// preview widget and the modal so a macro always gets a concrete light/dark.
// #207 (review rejection): PAPER renders pin the theme to light — the diagrams (mermaid /
// excalidraw / plantuml) bake the theme into their pixels at render time, so fixing `data-theme` on
// the document was never enough. The override is scoped and synchronous: dispatchMacroRender captures
// `ctx.theme` while the wrap is active, and the async fill-in uses the captured value.
let themeOverride: MacroTheme | null = null;
export function withMacroTheme<T>(theme: MacroTheme, fn: () => T): T {
  const prev = themeOverride;
  themeOverride = theme;
  try { return fn(); } finally { themeOverride = prev; }
}

export function currentMacroTheme(): MacroTheme {
  if (themeOverride) return themeOverride;
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return "dark";
  if (t === "light") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
