import { createContext, useContext, useState, type ReactNode } from "react";
import type { EditorUser } from "../editor/Editor";

// What the chrome needs to talk to the API (Authorization) and the collab server
// (docName needs tenantId). Member auth currently uses the dev-token bypass; the
// real OIDC redirect/callback flow is a separate chunk that will populate this
// same shape (see ADR-013 / the project design notes item 1).
export interface Session {
  token: string;
  tenantId: string;
  user: EditorUser;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}

const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080"];

export function SessionProvider({ children }: { children: ReactNode }) {
  // Resolved once. Tenant is derived from the API host server-side; the client
  // only needs it to form the collab docName (dev default: tenant_dev).
  const [session] = useState<Session>(() => {
    const env = (import.meta as any).env ?? {};
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    return {
      token: env.VITE_TOKEN ?? "dev-token",
      tenantId: env.VITE_TENANT ?? "tenant_dev",
      user: { name: `anon-${Math.floor(Math.random() * 1000)}`, color },
    };
  });

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
