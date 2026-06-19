import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { EditorUser } from "../editor/Editor";
import { apiFetch } from "../data/apiClient";

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
  user: EditorUser; // presence identity
  logout: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}

const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080"];

export function SessionProvider({ children }: { children: ReactNode }) {
  const env = (import.meta as any).env ?? {};
  const devToken: string | undefined = env.VITE_DEV_TOKEN;
  const tenantId: string = env.VITE_TENANT ?? "tenant_dev";

  const [presence] = useState<EditorUser>(() => ({
    name: `anon-${Math.floor(Math.random() * 1000)}`,
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
  }));
  const [status, setStatus] = useState<AuthStatus>(devToken ? "authed" : "loading");
  const [sub, setSub] = useState<string | null>(devToken ? "dev-user" : null);
  const [collabToken, setCollabToken] = useState<string>(devToken ?? "");

  useEffect(() => {
    if (devToken) return; // dev bypass: already authed, dev-token drives collab
    let cancelled = false;
    void (async () => {
      try {
        const me = await apiFetch<{ sub: string }>("/auth/me", ""); // cookie
        if (cancelled) return;
        if (!me) return setStatus("anon");
        setSub(me.sub);
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

  const logout = async () => {
    await apiFetch("/auth/logout", "", { method: "POST" }).catch(() => {});
    setStatus("anon");
    setSub(null);
    setCollabToken("");
  };

  const value: Session = {
    status,
    token: devToken ?? "",
    collabToken,
    tenantId,
    sub,
    user: presence,
    logout,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
