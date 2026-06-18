import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "./AppShell";
import { Editor } from "../editor/Editor";
import { Sidebar } from "../sidebar/Sidebar";
import { useSession } from "../session/SessionProvider";
import { fetchGuestToken, type GuestToken } from "../data/apiClient";

const COLLAB_URL = (import.meta as any).env?.VITE_COLLAB_URL ?? "ws://localhost:4100";

// Member route: /p/:pageId — tenant comes from the session, docName is formed
// the same way the collab server expects ("t:<tenant>:p:<page>").
function PageRoute() {
  const { pageId } = useParams<{ pageId: string }>();
  const { token, tenantId, user } = useSession();
  const docName = `t:${tenantId}:p:${pageId}`;
  return (
    <AppShell sidebar={<Sidebar />}>
      <Editor key={docName} docName={docName} token={token} collabUrl={COLLAB_URL} user={user} />
    </AppShell>
  );
}

// Guest route: /share/:linkId. The URL carries only the unguessable link id; we
// exchange it for a short-lived guest token at the public landing endpoint, then
// open the editor (read-only for view-capability links). No member chrome.
function ShareRoute() {
  const { linkId } = useParams<{ linkId: string }>();
  const [state, setState] = useState<{ status: "loading" | "denied" | "ok"; minted?: GuestToken }>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    if (!linkId) {
      setState({ status: "denied" });
      return;
    }
    fetchGuestToken(linkId).then((minted) => {
      if (cancelled) return;
      setState(minted ? { status: "ok", minted } : { status: "denied" });
    });
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  if (state.status === "loading") {
    return <AppShell><div style={{ padding: 16 }}>Opening shared page…</div></AppShell>;
  }
  if (state.status === "denied" || !state.minted) {
    return <AppShell><div style={{ padding: 16 }}>This share link is invalid, expired, or revoked.</div></AppShell>;
  }
  const { token, docName, readOnly } = state.minted;
  // Anonymous guest identity (never an OIDC account / seat — the project design notes).
  const guest = { name: `guest-${Math.floor(Math.random() * 1000)}`, color: "#7d8590" };
  return (
    <AppShell>
      <Editor key={docName} docName={docName} token={token} collabUrl={COLLAB_URL} user={guest} readOnly={readOnly} />
    </AppShell>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/p/:pageId" element={<PageRoute />} />
      <Route path="/share/:linkId" element={<ShareRoute />} />
      {/* Dev default: the seeded demo page. Real landing/space routing is a
          next-stage screen. */}
      <Route path="*" element={<Navigate to="/p/demo" replace />} />
    </Routes>
  );
}
