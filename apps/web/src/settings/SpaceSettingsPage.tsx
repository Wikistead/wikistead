import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppShell } from "../app/AppShell";
import { LoginScreen } from "../app/LoginScreen";
import { useActiveSpace } from "../app/ActiveSpace";
import { useSession } from "../session/SessionProvider";
import { useSpaces, useRenameSpace, useDeleteSpace } from "../data/queries";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/dialogs";
import { notify } from "../ui/toast";
import { SettingsShell, SettingsDenied, type SettingsTab } from "./SettingsShell";
import { SpaceMembersTab } from "./SpaceMembersTab";
import { SpaceThemeTab } from "./SpaceThemeTab";

interface SpaceCtx { spaceId: string; name: string; accentKey: string | null }

function useSpaceTabs(spaceId: string): SettingsTab[] {
  const { t } = useTranslation();
  return [
    { key: "general", label: t("spaceSettings.general"), to: `/spaces/${spaceId}/settings/general` },
    { key: "members", label: t("spaceSettings.members"), to: `/spaces/${spaceId}/settings/members` },
    { key: "theme", label: t("spaceSettings.theme"), to: `/spaces/${spaceId}/settings/theme` },
  ];
}

function SpaceSettingsLayout() {
  const { t } = useTranslation();
  const { spaceId } = useParams<{ spaceId: string }>();
  const { status, logout } = useSession();
  const { setActiveSpaceId } = useActiveSpace();
  const spacesQ = useSpaces();
  const tabs = useSpaceTabs(spaceId ?? "");

  // Opening a space's settings makes it the active space, so the accent cascade
  // (BrandingApplier) previews this space's accent live as it's edited on the Theme tab.
  useEffect(() => { if (spaceId) setActiveSpaceId(spaceId); }, [spaceId, setActiveSpaceId]);

  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  if (spacesQ.isLoading) return <AppShell onLogout={logout}><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;

  // useSpaces is FGA-filtered: a space the user cannot VIEW never appears here.
  // Leak rule: not viewable → 404 (hide its existence); viewable but not manage →
  // 403 (it's in their tree, so existence is already known — deny by permission).
  // The server stays the fortress: rename/delete re-check space#manage regardless.
  const space = (spacesQ.data ?? []).find((s) => s.id === spaceId);
  if (!space) return <AppShell onLogout={logout}><SettingsDenied kind="notFound" /></AppShell>;
  if (space.capability !== "manage") return <AppShell onLogout={logout}><SettingsDenied kind="forbidden" /></AppShell>;

  const ctx: SpaceCtx = { spaceId: space.id, name: space.name, accentKey: space.accentKey ?? null };
  return (
    <AppShell onLogout={logout}>
      <SettingsShell title={t("spaceSettings.title", { name: space.name })} tabs={tabs}>
        <Outlet context={ctx} />
      </SettingsShell>
    </AppShell>
  );
}

function SpaceGeneralTab() {
  const { t } = useTranslation();
  const { spaceId, name } = useOutletContext<SpaceCtx>();
  const navigate = useNavigate();
  const rename = useRenameSpace();
  const del = useDeleteSpace();
  const [draft, setDraft] = useState(name);
  const [confirming, setConfirming] = useState(false);

  const save = () => {
    const next = draft.trim();
    if (!next || next === name) return;
    rename.mutate({ spaceId, name: next }, {
      onSuccess: () => notify.success(t("toast.saved")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  return (
    <div style={{ padding: 24, maxWidth: 560 }} data-testid="space-general">
      <h2 style={{ marginTop: 0 }}>{t("spaceSettings.general")}</h2>

      <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", marginBottom: 6 }}>{t("spaceSettings.nameLabel")}</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 32 }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={t("spaceSettings.nameLabel")} data-testid="space-name-input" />
        <Button variant="primary" disabled={!draft.trim() || draft.trim() === name || rename.isPending} onClick={save} data-testid="space-name-save">{t("common.save")}</Button>
      </div>

      <h3 style={{ color: "var(--danger)" }}>{t("spaceSettings.dangerZone")}</h3>
      <p style={{ color: "var(--fg-dim)", fontSize: 13 }}>{t("spaceSettings.deleteHint")}</p>
      <Button variant="danger" onClick={() => setConfirming(true)} data-testid="space-delete">{t("spaceSettings.deleteSpace")}</Button>

      <ConfirmDialog
        open={confirming}
        title={t("spaceSettings.deleteConfirmTitle")}
        message={t("spaceSettings.deleteConfirm", { name })}
        confirmLabel={t("spaceSettings.deleteSpace")}
        tone="danger"
        confirmTestId="space-delete-confirm"
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          del.mutate(spaceId, {
            onSuccess: () => { notify.success(t("toast.spaceDeleted")); navigate("/"); },
            onError: () => notify.error(t("toast.actionFailed")),
          });
          setConfirming(false);
        }}
      />
    </div>
  );
}

// Returned as inline <Route> elements so the parent <Routes> can parse them.
export function SpaceSettingsRoutes() {
  return (
    <Route path="/spaces/:spaceId/settings" element={<SpaceSettingsLayout />}>
      <Route index element={<Navigate to="general" replace />} />
      <Route path="general" element={<SpaceGeneralTab />} />
      <Route path="members" element={<SpaceMembersTab />} />
      <Route path="theme" element={<SpaceThemeTab />} />
    </Route>
  );
}
