import { useEffect } from "react";
import { useTheme } from "./ThemeProvider";
import { useActiveSpace } from "./ActiveSpace";
import { useSession } from "../session/SessionProvider";
import { useSpaces, useBranding } from "../data/queries";
import { applyAccent } from "./branding";

// Applies the accent cascade (Phase 5c: space ▷ default; 5d adds tenant in the
// middle) to :root. Non-rendering — mounted once at the app root, like <Toasts/>.
// Reacts to the active space and the personal theme (incl. live OS scheme changes
// under "system"). Members only resolve a space accent; guests/anon fall back to
// the default (tenant accent for guests arrives in 5d via public GET /branding).
export function BrandingApplier() {
  const { theme } = useTheme();
  const { status } = useSession();
  const { activeSpaceId } = useActiveSpace();
  const spacesQ = useSpaces(status === "authed");
  const spaceAccent = status === "authed"
    ? (spacesQ.data?.find((s) => s.id === activeSpaceId)?.accentKey ?? null)
    : null;
  // Tenant accent is public (GET /branding), so it applies for everyone incl. guests.
  const tenantAccent = useBranding().data?.accentKey ?? null;
  const effective = spaceAccent ?? tenantAccent; // space ▷ tenant ▷ default

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
