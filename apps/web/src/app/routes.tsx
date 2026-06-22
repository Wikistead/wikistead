import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { AppShell } from "./AppShell";
import { LoginScreen } from "./LoginScreen";
import { AdminRoutes } from "../settings/AdminPage";
import { SpaceSettingsRoutes } from "../settings/SpaceSettingsPage";
import { Editor, type AnchorGetter, type EditorLayout } from "../editor/Editor";
import { PageToolbar } from "./PageToolbar";
import { ShareDialog } from "../ui/ShareDialog";
import { CommentsPanel } from "../comments/CommentsPanel";
import { HistoryPanel } from "../history/HistoryPanel";
import { PermissionsDialog } from "../ui/PermissionsDialog";
import { Button } from "../ui/Button";
import { notify } from "../ui/toast";
import { useComments } from "../data/comments";
import { Sidebar } from "../sidebar/Sidebar";
import { SearchBox } from "../search/SearchBox";
import { AttachmentsPanel } from "../attachments/AttachmentsPanel";
import { useSession } from "../session/SessionProvider";
import { fetchGuestToken, apiFetch, type GuestToken } from "../data/apiClient";
import { usePage, usePublished, usePublish } from "../data/queries";
import { uploadAttachment } from "../attachments/useAttachments";
import { downloadPageExport } from "../data/exportApi";
import { useActiveSpace } from "./ActiveSpace";

// Same-origin collab (ADR-016): a relative "/collab" is resolved against the
// current origin to an absolute ws(s):// URL (WebSocket needs an absolute URL),
// so it goes through the same proxy as /api. Absolute ws URLs are used as-is.
function resolveCollabUrl(): string {
  const v = (import.meta as any).env?.VITE_COLLAB_URL ?? "/collab";
  if (/^wss?:\/\//.test(v)) return v;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${v.startsWith("/") ? v : `/${v}`}`;
}
const COLLAB_URL = resolveCollabUrl();

// Member route: /p/:pageId — tenant comes from the session, docName is formed
// the same way the collab server expects ("t:<tenant>:p:<page>").
function PageRoute() {
  const { t } = useTranslation();
  const { pageId } = useParams<{ pageId: string }>();
  const [searchParams] = useSearchParams();
  const autoEdit = searchParams.get("edit") === "1"; // set by the create-page flow
  const { status, collabToken, tenantId, user, logout, token } = useSession();
  // Capability gates the Edit control (UI only — collab server is the fortress).
  // Defaults to view until resolved, so a page is never editable speculatively.
  // The dev-token bypass is god-mode (matches collab's dev-token = readOnly:false),
  // so it defaults to edit — and works for not-yet-persisted pages getPage 404s on.
  const devMode = token === "dev-token";
  const { data: page } = usePage(pageId ?? "");
  const capability = page?.capability ?? (devMode ? "edit" : "view");

  // Draft/publish: view renders the PUBLISHED snapshot; edit-capable users get a
  // Publish control + an "unpublished changes" indicator.
  const { data: published } = usePublished(pageId ?? "");
  const publish = usePublish(pageId ?? "");

  // Opening any page makes its space the active one, so the sidebar follows —
  // including when arriving from cross-space search or a share link.
  const { setActiveSpaceId } = useActiveSpace();
  const openSpaceId = page?.spaceId;
  useEffect(() => { if (openSpaceId) setActiveSpaceId(openSpaceId); }, [openSpaceId, setActiveSpaceId]);

  // Upload a picked image to this page's space, returning the ref to insert. Bound
  // to the resolved spaceId; null (no image button) until the page meta loads.
  const spaceId = page?.spaceId;
  const onUploadImage = useCallback(
    async (file: File) => {
      if (!spaceId || !pageId) return null;
      const { id, filename } = await uploadAttachment(spaceId, pageId, token, file);
      return { ref: `wks-attachment:${id}`, alt: filename };
    },
    [spaceId, pageId, token],
  );

  // Inline-comment integration: the panel and the editor share one comments query.
  // Inline threads (with anchors) become editor highlights; the panel builds inline
  // threads from the editor's current selection via this anchor getter.
  const anchorGetterRef = useRef<AnchorGetter | null>(null);
  const { data: threads } = useComments(pageId ?? "");
  const inlineComments = (threads ?? [])
    .filter((t) => t.kind === "inline" && t.anchorStart && t.anchorEnd)
    .map((t) => ({ threadId: t.id, anchorStart: t.anchorStart!, anchorEnd: t.anchorEnd!, resolved: t.status === "resolved" }));
  const openComments = (threads ?? []).filter((t) => t.status === "open").length;

  // Comments panel is toggled (not always-on); the choice persists. Inline blue
  // underlines stay in the editor regardless — the panel is the thread list layer.
  const [commentsOpen, setCommentsOpen] = useState(() => {
    try { return localStorage.getItem("wks.commentsOpen") === "1"; } catch { return false; }
  });
  const toggleComments = () => setCommentsOpen((v) => {
    const n = !v;
    try { localStorage.setItem("wks.commentsOpen", n ? "1" : "0"); } catch { /* no storage */ }
    return n;
  });

  // History panel is toggled the same way (persisted). Listing needs view; restore
  // is offered only to edit-capable users (the server re-checks both).
  const [historyOpen, setHistoryOpen] = useState(() => {
    try { return localStorage.getItem("wks.historyOpen") === "1"; } catch { return false; }
  });
  const toggleHistory = () => setHistoryOpen((v) => {
    const n = !v;
    try { localStorage.setItem("wks.historyOpen", n ? "1" : "0"); } catch { /* no storage */ }
    return n;
  });

  // Per-page permissions (manage only). Also the invite-to-draft surface.
  const [permsOpen, setPermsOpen] = useState(false);
  const [sharing, setSharing] = useState(false); // share dialog (current page)

  // Edit mode + layout are owned here now (PageToolbar is the chrome). editing
  // starts true for the create-page flow (?edit=1). layout (single/split) persists.
  const canEdit = capability === "edit";
  const [editing, setEditing] = useState(autoEdit);
  // Navigating to another page opens it in READ mode (unless ?edit=1) — PageRoute is
  // not remounted on a param change, so reset editing when the page changes.
  useEffect(() => { setEditing(autoEdit); }, [pageId, autoEdit]);
  const [layout, setLayout] = useState<EditorLayout>(() => {
    try { return localStorage.getItem("wks.editorLayout") === "split" ? "split" : "wysiwyg"; } catch { return "wysiwyg"; }
  });
  const toggleLayout = () => setLayout((l) => {
    const n = l === "split" ? "wysiwyg" : "split";
    try { localStorage.setItem("wks.editorLayout", n); } catch { /* no storage */ }
    return n;
  });
  // Draft / Unpublished-changes chip (read mode); only meaningful for editors.
  const publishState = !canEdit ? null : published?.publishedMd == null ? "draft" : published?.hasUnpublishedChanges ? "unpublished" : null;

  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  const docName = `t:${tenantId}:p:${pageId}`;
  return (
    <AppShell sidebar={<Sidebar />} search={<SearchBox />} onLogout={logout}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <PageToolbar
            title={page?.title ?? ""}
            canEdit={canEdit}
            editing={editing}
            onEdit={() => setEditing(true)}
            onDone={() => setEditing(false)}
            publishState={publishState}
            canPublish={!!published?.hasUnpublishedChanges}
            onPublish={canEdit ? () => publish.mutate(undefined, {
              onSuccess: () => notify.success(t("toast.published")),
              onError: () => notify.error(t("toast.publishFailed")),
            }) : undefined}
            publishing={publish.isPending}
            layout={layout}
            onToggleLayout={toggleLayout}
            onShare={() => setSharing(true)}
            commentsOpen={commentsOpen}
            onToggleComments={toggleComments}
            openComments={openComments}
            onHistory={toggleHistory}
            onExport={() => { if (pageId) void downloadPageExport(token, pageId); }}
            onPrint={() => window.print()}
            onPermissions={page?.canManage ? () => setPermsOpen(true) : undefined}
          />
          <div style={{ flex: 1, minHeight: 0 }}>
            <Editor key={docName} docName={docName} token={collabToken} collabUrl={COLLAB_URL} user={user} capability={capability} apiToken={token} publishedMd={published?.publishedMd ?? null} editing={editing} layout={layout} onUploadImage={onUploadImage} inlineComments={inlineComments} anchorGetterRef={anchorGetterRef} />
          </div>
          {pageId && <AttachmentsPanel pageId={pageId} readOnly={capability !== "edit"} />}
        </div>
        {pageId && commentsOpen && <CommentsPanel pageId={pageId} canComment={capability === "edit"} anchorGetterRef={anchorGetterRef} />}
        {pageId && historyOpen && <HistoryPanel pageId={pageId} canRestore={capability === "edit"} />}
      </div>
      {pageId && <PermissionsDialog pageId={pageId} open={permsOpen} onClose={() => setPermsOpen(false)} />}
      <ShareDialog pageId={sharing ? pageId ?? null : null} onClose={() => setSharing(false)} />
    </AppShell>
  );
}

// Guest route: /share/:linkId. The URL carries only the unguessable link id; we
// exchange it for a short-lived guest token at the public landing endpoint, then
// open the editor (read-only for view-capability links). No member chrome.
function ShareRoute() {
  const { t } = useTranslation();
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
    return <AppShell><div style={{ padding: 16 }}>{t("share.opening")}</div></AppShell>;
  }
  if (state.status === "denied" || !state.minted) {
    return <AppShell><div style={{ padding: 16 }}>{t("share.invalid")}</div></AppShell>;
  }
  return <GuestPage minted={state.minted} />;
}

// The shared page for an anonymous guest (after the link → token exchange). Same
// draft/publish model as members: VIEW links render the PUBLISHED snapshot (no
// collab — the live draft never reaches a view guest's browser); EDIT links join
// the collab draft to co-edit and can Publish. The published content is fetched
// over HTTP with the guest token (the server re-checks the share_link's authority).
function GuestPage({ minted }: { minted: GuestToken }) {
  const { t } = useTranslation();
  const { token, docName, capability } = minted;
  const pageId = docName.replace(/^t:.+?:p:/, "");
  // Anonymous guest identity (never an OIDC account / seat — the project design notes).
  const [guest] = useState(() => ({ name: `guest-${Math.floor(Math.random() * 1000)}`, color: "#7d8590" }));
  const [publishedMd, setPublishedMd] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const canEdit = capability === "edit";
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<EditorLayout>(() => {
    try { return localStorage.getItem("wks.editorLayout") === "split" ? "split" : "wysiwyg"; } catch { return "wysiwyg"; }
  });
  const toggleLayout = () => setLayout((l) => {
    const n = l === "split" ? "wysiwyg" : "split";
    try { localStorage.setItem("wks.editorLayout", n); } catch { /* no storage */ }
    return n;
  });

  const reloadPublished = useCallback(() => {
    apiFetch<{ publishedMd: string | null }>(`/pages/${encodeURIComponent(pageId)}/published`, token)
      .then((r) => setPublishedMd(r?.publishedMd ?? null))
      .catch(() => { /* denied/expired → empty view */ });
  }, [pageId, token]);
  useEffect(() => { reloadPublished(); }, [reloadPublished]);

  const onPublish = async () => {
    setPublishing(true);
    try {
      await apiFetch(`/pages/${encodeURIComponent(pageId)}/publish`, token, { method: "POST" });
      notify.success(t("toast.published"));
    } catch {
      notify.error(t("toast.publishFailed"));
    }
    setPublishing(false);
    reloadPublished();
  };

  return (
    <AppShell>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <PageToolbar
          title=""
          canEdit={canEdit}
          editing={editing}
          onEdit={() => setEditing(true)}
          onDone={() => setEditing(false)}
          layout={layout}
          onToggleLayout={toggleLayout}
          canPublish
          onPublish={canEdit ? () => void onPublish() : undefined}
          publishing={publishing}
        />
        <div style={{ flex: 1, minHeight: 0 }}>
          <Editor key={docName} docName={docName} token={token} collabUrl={COLLAB_URL} user={guest} capability={capability} apiToken={token} publishedMd={publishedMd} editing={editing} layout={layout} />
        </div>
      </div>
    </AppShell>
  );
}

// Cloud signup landing (platform origin). Public — no session yet. Starts the
// platform-IdP flow as a top-level navigation to /signup/login (proxied to the API).
function JoinRoute() {
  const { t } = useTranslation();
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>{t("auth.joinTitle")}</h2>
        <p style={{ color: "var(--fg-dim)" }}>{t("auth.joinBody")}</p>
        <Button variant="primary" onClick={() => { window.location.href = "/signup/login"; }}>{t("auth.signUp")}</Button>
      </div>
    </AppShell>
  );
}

// After platform-IdP signup: choose a workspace name → POST /signup/tenants (uses
// the signup session cookie) → redirect to the new tenant subdomain, where the
// member logs in via platform-IdP SSO (a fresh host-only member session there).
function WorkspaceRoute() {
  const { t } = useTranslation();
  const [slug, setSlug] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    const res = await fetch("/signup/tenants", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    if (res.ok) {
      const { tenantUrl } = (await res.json()) as { tenantUrl: string };
      window.location.href = tenantUrl;
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setErr(body.error ?? t("auth.createWorkspaceError"));
    setBusy(false);
  };
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>{t("auth.workspaceTitle")}</h2>
        <p style={{ color: "var(--fg-dim)" }}>{t("auth.workspaceBody")}</p>
        <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t("auth.workspacePlaceholder")} aria-label={t("auth.workspaceName")} />
        {err && <p style={{ color: "crimson" }}>{err}</p>}
        <Button variant="primary" disabled={busy || !slug} onClick={submit}>{t("auth.createWorkspace")}</Button>
      </div>
    </AppShell>
  );
}

// Invite acceptance landing: the link carries ?token. Accepting starts the OIDC
// login with the token attached (?invite=) — the callback accepts the invite and
// seats the user (the new membership grant). The token is opaque to the SPA.
function InviteRoute() {
  const { t } = useTranslation();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const accept = () => {
    window.location.href = `/auth/login?invite=${encodeURIComponent(token)}&returnTo=${encodeURIComponent("/p/demo")}`;
  };
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>{t("auth.inviteTitle")}</h2>
        <p style={{ color: "var(--fg-dim)" }}>{t("auth.inviteBody")}</p>
        <Button variant="primary" disabled={!token} onClick={accept}>{t("auth.acceptInvite")}</Button>
      </div>
    </AppShell>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/p/:pageId" element={<PageRoute />} />
      <Route path="/share/:linkId" element={<ShareRoute />} />
      <Route path="/invite" element={<InviteRoute />} />
      {AdminRoutes()}
      {SpaceSettingsRoutes()}
      {/* Back-compat: the old members URL now lives under the admin console. */}
      <Route path="/settings/members" element={<Navigate to="/admin/members" replace />} />
      <Route path="/join" element={<JoinRoute />} />
      <Route path="/join/workspace" element={<WorkspaceRoute />} />
      {/* Dev default: the seeded demo page. Real landing/space routing is a
          next-stage screen. */}
      <Route path="*" element={<Navigate to="/p/demo" replace />} />
    </Routes>
  );
}
