import { useEffect } from "react";
import { useTheme } from "./ThemeProvider";
import { useBranding } from "../data/queries";
import { applyAccent } from "./branding";

// Applies the accent cascade to :root. Non-rendering — mounted once at the app root, like <Toasts/>.
// #201: the cascade is USER personal accent (device-local, this user only) ▷ TENANT accent (the
// white-label default, public GET /branding, applies to everyone incl. guests). Spaces no longer
// carry an accent (they are distinguished by their icon). Reacts to the personal theme (incl. live OS
// scheme changes under "system"). The tenant accent is always a concrete colour, so this always
// resolves to a concrete colour (no "which colour?" ambiguity).
export function BrandingApplier() {
  const { theme, accent: userAccent } = useTheme();
  // Tenant accent is public (GET /branding), so it applies for everyone incl. guests.
  const tenantAccent = useBranding().data?.accentKey ?? null;
  const effective = userAccent ?? tenantAccent; // user personal ▷ tenant ▷ default

  useEffect(() => {
    applyAccent(effective, theme);
    // Under "system", track live OS light/dark flips so the right variant applies.
    if (theme !== "system" || typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyAccent(effective, theme);
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [effective, theme]);

  return null;
}
