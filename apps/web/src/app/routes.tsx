import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "./AppShell";
import { Editor } from "../editor/Editor";
import { Sidebar } from "../sidebar/Sidebar";
import { useSession } from "../session/SessionProvider";

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

// Decode the unverified JWT payload just to form the docName. The collab server
// re-verifies the token authoritatively (apps/collab onAuthenticate); this is
// only for routing.
function decodeGuestDoc(shareToken: string): string | null {
  try {
    const payload = JSON.parse(atob(shareToken.split(".")[1]));
    const tenantId = payload.tenantId;
    const pageId = payload.resource?.type === "page" ? payload.resource.id : null;
    return tenantId && pageId ? `t:${tenantId}:p:${pageId}` : null;
  } catch {
    return null;
  }
}

// Guest route: /share/:shareToken — token IS the app-signed share token. The
// guest-facing chrome (read-only affordances, capability banner) is a next-stage
// screen; this wires the editor surface so the route is functional.
function ShareRoute() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const docName = shareToken ? decodeGuestDoc(shareToken) : null;
  if (!shareToken || !docName) {
    return <AppShell><div style={{ padding: 16 }}>Invalid or expired share link.</div></AppShell>;
  }
  return (
    <AppShell>
      <Editor
        key={docName}
        docName={docName}
        token={shareToken}
        collabUrl={COLLAB_URL}
        user={{ name: "guest", color: "#888888" }}
      />
    </AppShell>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/p/:pageId" element={<PageRoute />} />
      <Route path="/share/:shareToken" element={<ShareRoute />} />
      {/* Dev default: the seeded demo page. Real landing/space routing is a
          next-stage screen. */}
      <Route path="*" element={<Navigate to="/p/demo" replace />} />
    </Routes>
  );
}
