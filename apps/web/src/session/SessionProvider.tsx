import { createContext, useContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EditorUser } from "../editor/Editor";
import { apiFetch, assetUrl } from "../data/apiClient";
import { shortPrincipalId } from "../ui/principal-label"; // #578
import { colorFromString } from "../ui/avatar";

// An uploaded avatar comes back as a relative API path (/members/:sub/avatar-image) that
// must go through the API base to load as an <img>; an OIDC picture is an absolute URL —
// leave it untouched. (ADR-020 + the asset-URL /api-prefix rule.)
const normPicture = (p: string | null | undefined): string | null =>
  p ? (p.startsWith("/") ? assetUrl(p) : p) : null;

// Auth modes (ADR-016 / P1.1):
//  - DEV: VITE_DEV_TOKEN set (dev/e2e) → authenticated via the dev-token bypass;
//    the same token is used for the API (Bearer) and collab. No login screen.
//  - REAL: no dev token → BFF cookie. /auth/me decides authed vs anon; a member
//    collab token is fetched from /auth/collab-token for the WebSocket.
export type AuthStatus = "loading" | "authed" | "anon";

export interface Session {
  status: AuthStatus;
  token: string; // Bearer for apiFetch (dev-token) or "" (cookie member)
  collabToken: string; // token handed to the collab WebSocket
  tenantId: string;
  sub: string | null;
  // #427: TRUE while the dev-token god-mode identity (dev-user) is active. A REAL cookie
  // session always wins over the bypass (see the probe effect); the header shows a DEV
  // badge while this is set so god-mode is never mistaken for a product identity.
  devMode: boolean;
  // UI-convenience flag (tenant#admin) for menu/route gating ONLY. NOT a security
  // boundary — every admin action re-checks tenant#admin server-side.
  isAdmin: boolean;
  // Peer-visible identity (#3): the member's display name and OIDC picture (null →
  // initials avatar). NEVER includes email. Drives the header avatar and the collab
  // cursor (#8). displayName falls back to sub for the dev/bootstrap case.
  displayName: string | null;
  picture: string | null;
  user: EditorUser; // presence identity (name + deterministic colour + picture)
  logout: () => Promise<void>;
  // Re-pull /auth/me so the header avatar / name / collab identity reflect a just-saved
  // account-settings change live (no reload). Account settings call this on success.
  refresh: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const env = (import.meta as any).env ?? {};
  // #427 (c): VITE_DEV_TOKEN_DISABLE=1 turns the bypass off from .env.local. Vite's precedence
  // puts .env.development ABOVE .env.local for the SAME var, so un-setting VITE_DEV_TOKEN there
  // never worked — a DIFFERENT opt-out var is not shadowed. Empty string counts as unset
  // (.env.realauth pins VITE_DEV_TOKEN= to force real auth).
  const devToken: string | undefined =
    env.VITE_DEV_TOKEN_DISABLE === "1" ? undefined : env.VITE_DEV_TOKEN || undefined;
  const tenantId: string = env.VITE_TENANT ?? "tenant_dev";

  const [status, setStatus] = useState<AuthStatus>(devToken ? "authed" : "loading");
  const [sub, setSub] = useState<string | null>(devToken ? "dev-user" : null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [picture, setPicture] = useState<string | null>(null);
  // dev-token is god-mode (tenant admin) to match the server's dev bypass.
  const [isAdmin, setIsAdmin] = useState<boolean>(!!devToken);
  const [collabToken, setCollabToken] = useState<string>(devToken ?? "");
  // #427 (a): god-mode is PROVISIONAL — the probe below hands the identity to a real cookie
  // session when one exists. Until then the dev token renders instantly (no loading flash,
  // and the e2e dev-token contexts — which never carry a cookie — are untouched).
  const [devMode, setDevMode] = useState<boolean>(!!devToken);

  useEffect(() => {
    let cancelled = false;
    // #431 god-mode resolves its CANONICAL identity — /auth/me via the dev bearer returns
    // dev-user's display_name ("Dev User"), the same source the members surfaces read. Without it
    // the header/author chips fell back to the sub and showed "DE" while member management showed
    // "DU" for the same user. Colour stays sub-seeded (#431 round 1) — only the name source unifies.
    const resolveGodModeIdentity = async () => {
      if (!devToken) return;
      try {
        const dev = await apiFetch<{ displayName?: string | null; picture?: string | null }>("/auth/me", devToken);
        if (!cancelled && dev) {
          setDisplayName(dev.displayName ?? null);
          setPicture(normPicture(dev.picture));
        }
      } catch { /* keep the sub fallback on a transient error */ }
    };
    void (async () => {
      try {
        // /auth/me exposes ONLY sub + displayName + picture (never email) — #3. Cookie only:
        // with a dev token this probes for a REAL session (#427 — a logged-in identity must
        // never be masked by the bypass); without one it decides authed vs anon as before.
        const me = await apiFetch<{ sub: string; isAdmin?: boolean; displayName?: string | null; picture?: string | null }>("/auth/me", ""); // cookie
        if (cancelled) return;
        if (!me) {
          if (!devToken) { setStatus("anon"); return; }
          await resolveGodModeIdentity();
          return; // stay in god-mode (a real cookie session still takes over when it exists)
        }
        setSub(me.sub);
        setIsAdmin(!!me.isAdmin);
        setDisplayName(me.displayName ?? null);
        setPicture(normPicture(me.picture));
        const ct = await apiFetch<{ token: string }>("/auth/collab-token", "", { method: "POST" });
        if (cancelled) return;
        setCollabToken(ct?.token ?? "");
        setDevMode(false); // the real session owns the identity from here on
        setStatus("authed");
      } catch {
        if (cancelled) return;
        if (!devToken) { setStatus("anon"); return; } // 401 → show login (real mode only)
        await resolveGodModeIdentity(); // 401 with a dev token = plain god-mode (#431)
      }
    })();
    return () => { cancelled = true; };
  }, [devToken]);

  // Presence identity (#3 + #8): deterministic so the SAME member always gets the same
  // colour across reloads and across peers, with no random churn that would thrash
  // awareness. Colour is seeded from the stable `sub` (survives renames); the name is
  // the display name, falling back to the sub when the IdP omits it.
  const user = useMemo<EditorUser>(() => {
    const seed = sub ?? "anon";
    // #578: this name rides the collab cursor, so it is what OTHER people see. Falling through to
    // `sub` put a 70-character hex string on somebody else's screen; the short id is readable and
    // still distinguishes two unnamed editors.
    return { name: displayName ?? (sub ? shortPrincipalId(sub) : "anon"), color: colorFromString(seed), picture, seed };
  }, [sub, displayName, picture]);

  const logout = async () => {
    await apiFetch("/auth/logout", "", { method: "POST" }).catch(() => {});
    setStatus("anon");
    setSub(null);
    setDisplayName(null);
    setPicture(null);
    setIsAdmin(false);
    setCollabToken("");
  };

  const refresh = useCallback(async () => {
    try {
      // Use the ACTIVE mode's authority (#427): once a real session owns the identity,
      // refresh must not fall back to the dev bearer (that would re-mask the real user).
      const me = await apiFetch<{ displayName?: string | null; picture?: string | null }>("/auth/me", devMode ? devToken ?? "" : "");
      if (!me) return;
      setDisplayName(me.displayName ?? null);
      setPicture(normPicture(me.picture));
    } catch { /* keep the current identity on a transient error */ }
  }, [devToken, devMode]);

  const value: Session = {
    status,
    // #427: the dev bearer authorizes API calls only WHILE god-mode is active; a real
    // session switches the app to cookie authority (same as REAL mode).
    token: devMode ? devToken ?? "" : "",
    collabToken,
    tenantId,
    sub,
    devMode,
    isAdmin,
    displayName,
    picture,
    user,
    logout,
    refresh,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
