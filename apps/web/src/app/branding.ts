import type { Theme } from "./ThemeProvider";

// Branding accent palette (Phase 5c/5d). Branding stores a preset KEY (validated
// server-side against ACCENT_PRESETS in @wikistead/types); the actual colours live
// here so they can be tuned freely. Each preset has a light + dark variant (to sit
// on the personal light/dark base) and an `fg` = the contrasting text colour on an
// accent fill. Only --accent / --accent-fg are overridden; --bg/--fg (personal
// theme) are never touched, and --selection auto-follows (tokens.css derives it
// from var(--accent) via color-mix). Keys must match ACCENT_PRESETS exactly.
type Variant = { accent: string; fg: string };
export const ACCENT_PALETTE: Record<string, { light: Variant; dark: Variant }> = {
  blue:   { light: { accent: "#2563eb", fg: "#ffffff" }, dark: { accent: "#4ea1ff", fg: "#06243f" } },
  indigo: { light: { accent: "#4f46e5", fg: "#ffffff" }, dark: { accent: "#818cf8", fg: "#0b1020" } },
  violet: { light: { accent: "#7c3aed", fg: "#ffffff" }, dark: { accent: "#a78bfa", fg: "#1a0b2e" } },
  green:  { light: { accent: "#16a34a", fg: "#ffffff" }, dark: { accent: "#4ade80", fg: "#052e16" } },
  teal:   { light: { accent: "#0d9488", fg: "#ffffff" }, dark: { accent: "#2dd4bf", fg: "#042f2a" } },
  amber:  { light: { accent: "#d97706", fg: "#ffffff" }, dark: { accent: "#fbbf24", fg: "#2a1a02" } },
  rose:   { light: { accent: "#e11d48", fg: "#ffffff" }, dark: { accent: "#fb7185", fg: "#2a0712" } },
  slate:  { light: { accent: "#475569", fg: "#ffffff" }, dark: { accent: "#94a3b8", fg: "#0a0f1a" } },
};

// The preset keys, in display order. MUST match ACCENT_PRESETS in @wikistead/types
// (the server validates writes against that allowlist); kept here too so the web
// app needs no workspace import for the picker.
export const ACCENT_PRESETS = Object.keys(ACCENT_PALETTE);

// Resolve "system" to the OS preference; explicit light/dark pass through.
export function resolvedScheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Apply (or clear) the accent override on :root. Inline styles beat the stylesheet
// :root rules, so this wins over the default token; clearing reverts to default.
export function applyAccent(key: string | null | undefined, theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const preset = key ? ACCENT_PALETTE[key] : undefined;
  if (!preset) {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-fg");
    return;
  }
  const v = preset[resolvedScheme(theme)];
  root.style.setProperty("--accent", v.accent);
  root.style.setProperty("--accent-fg", v.fg);
}
