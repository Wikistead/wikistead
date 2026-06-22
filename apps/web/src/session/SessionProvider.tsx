import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EditorUser } from "../editor/Editor";
import { apiFetch } from "../data/apiClient";
import { colorFromString } from "../ui/avatar";

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
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const env = (import.meta as any).env ?? {};
  const devToken: string | undefined = env.VITE_DEV_TOKEN;
  const tenantId: string = env.VITE_TENANT ?? "tenant_dev";

  const [status, setStatus] = useState<AuthStatus>(devToken ? "authed" : "loading");
  const [sub, setSub] = useState<string | null>(devToken ? "dev-user" : null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [picture, setPicture] = useState<string | null>(null);
  // dev-token is god-mode (tenant admin) to match the server's dev bypass.
  const [isAdmin, setIsAdmin] = useState<boolean>(!!devToken);
  const [collabToken, setCollabToken] = useState<string>(devToken ?? "");

  useEffect(() => {
    if (devToken) return; // dev bypass: already authed, dev-token drives collab
    let cancelled = false;
    void (async () => {
      try {
        // /auth/me exposes ONLY sub + displayName + picture (never email) — #3.
        const me = await apiFetch<{ sub: string; isAdmin?: boolean; displayName?: string | null; picture?: string | null }>("/auth/me", ""); // cookie
        if (cancelled) return;
        if (!me) return setStatus("anon");
        setSub(me.sub);
        setIsAdmin(!!me.isAdmin);
        setDisplayName(me.displayName ?? null);
        setPicture(me.picture ?? null);
        const ct = await apiFetch<{ token: string }>("/auth/collab-token", "", { method: "POST" });
        if (cancelled) return;
        setCollabToken(ct?.token ?? "");
        setStatus("authed");
      } catch {
        if (!cancelled) setStatus("anon"); // 401 → show login
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
    return { name: displayName ?? sub ?? "anon", color: colorFromString(seed), picture, seed };
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

  const value: Session = {
    status,
    token: devToken ?? "",
    collabToken,
    tenantId,
    sub,
    isAdmin,
    displayName,
    picture,
    user,
    logout,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
