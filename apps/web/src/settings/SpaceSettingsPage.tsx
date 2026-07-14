import { useEffect, useRef, useState } from "react";
import { Navigate, Outlet, Route, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppShell } from "../app/AppShell";
import { LoginScreen } from "../app/LoginScreen";
import { useActiveSpace } from "../app/ActiveSpace";
import { useSession } from "../session/SessionProvider";
import { useSpaces, useRenameSpace, useDeleteSpace, useUploadSpaceIcon, useRemoveSpaceIcon, usePublicSurface, useSpacePublic, useSetSpacePublic } from "../data/queries";
import { Button } from "../ui/Button";
import { ShareDialog } from "../ui/ShareDialog";
import { Input } from "../ui/Input";
import { SpaceIcon } from "../ui/SpaceIcon";
import { Switch } from "../ui/Switch";
import { ConfirmDialog } from "../ui/dialogs";
import { notify } from "../ui/toast";
import { SettingsShell, SettingsDenied, type SettingsTab } from "./SettingsShell";
import { SpaceMembersTab } from "./SpaceMembersTab";
import { SpacePagesTab } from "./SpacePagesTab";

interface SpaceCtx { spaceId: string; name: string; accentKey: string | null; iconImageUrl: string | null }

const ICON_MAX_BYTES = 512 * 1024;
const ICON_TYPES = /^image\/(png|jpeg|webp)$/;

function useSpaceTabs(spaceId: string): SettingsTab[] {
  const { t } = useTranslation();
  return [
    { key: "general", label: t("spaceSettings.general"), to: `/spaces/${spaceId}/settings/general` },
    { key: "members", label: t("spaceSettings.members"), to: `/spaces/${spaceId}/settings/members` },
    { key: "pages", label: t("spaceSettings.pages"), to: `/spaces/${spaceId}/settings/pages` },
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

  const ctx: SpaceCtx = { spaceId: space.id, name: space.name, accentKey: space.accentKey ?? null, iconImageUrl: space.iconImageUrl ?? null };
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
  const { spaceId, name, iconImageUrl } = useOutletContext<SpaceCtx>();
  const navigate = useNavigate();
  const rename = useRenameSpace();
  const del = useDeleteSpace();
  const uploadIcon = useUploadSpaceIcon(spaceId);
  const removeIcon = useRemoveSpaceIcon(spaceId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(name);
  const [confirming, setConfirming] = useState(false);
  const [sharing, setSharing] = useState(false);

  // #277 / ADR-116: the space public toggle — offered ONLY while the tenant parent switch is ON
  // (mirrors the page toggle in PermissionsDialog; the server re-checks manage + the switch anyway).
  const { data: surfaceOn } = usePublicSurface();
  const { data: isPublic } = useSpacePublic(spaceId, !!surfaceOn);
  const setPublic = useSetSpacePublic(spaceId);
  const publicUrl = `${window.location.origin}/pub/space/${spaceId}`;
  const applyPublic = (v: boolean) => setPublic.mutate(v, {
    onSuccess: () => notify.success(t("toast.saved")),
    onError: (err) => {
      const status = (err as { status?: number }).status;
      notify.error(t(status === 403 ? "spaceSettings.publicErrorSurface" : "toast.actionFailed"));
    },
  });
  const copyPublicUrl = async () => {
    try { await navigator.clipboard.writeText(publicUrl); notify.success(t("toast.copied")); }
    catch { notify.error(t("toast.actionFailed")); }
  };

  // Image upload mirrors the tenant logo: base64 in, server re-validates magic bytes
  // + size. Unset → the space shows its auto initials chip.
  const onPickIcon = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (!ICON_TYPES.test(file.type)) { notify.error(t("tenantBranding.logoType")); return; }
    if (file.size > ICON_MAX_BYTES) { notify.error(t("tenantBranding.logoSize")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result);
      const b64 = res.slice(res.indexOf(",") + 1); // strip the data: URL prefix
      uploadIcon.mutate(b64, {
        onSuccess: () => notify.success(t("toast.saved")),
        onError: () => notify.error(t("toast.actionFailed")),
      });
    };
    reader.readAsDataURL(file);
  };

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
        <Input className="max-w-xs" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={t("spaceSettings.nameLabel")} data-testid="space-name-input" />
        <Button variant="primary" disabled={!draft.trim() || draft.trim() === name || rename.isPending} onClick={save} data-testid="space-name-save">{t("common.save")}</Button>
      </div>

      {/* Space icon: an uploaded image, else the auto initials chip (no text glyph). */}
      <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", marginBottom: 6 }}>{t("spaceSettings.iconLabel")}</label>
      <p style={{ color: "var(--fg-dim)", fontSize: 13, marginTop: 0 }}>{t("spaceSettings.iconHint")}</p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 32 }}>
        {/* Live preview of what the sidebar will show: image ▷ auto initials. */}
        <SpaceIcon id={spaceId} name={name} image={iconImageUrl} size={28} data-testid="space-icon-preview" />
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="space-icon-image-input" onChange={onPickIcon} />
        <Button variant="default" disabled={uploadIcon.isPending} onClick={() => fileRef.current?.click()} data-testid="space-icon-image-upload">{t("spaceSettings.iconImageUpload")}</Button>
        {iconImageUrl && (
          <Button variant="dangerGhost" disabled={removeIcon.isPending} data-testid="space-icon-image-remove"
            onClick={() => removeIcon.mutate(undefined, { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("toast.actionFailed")) })}>{t("spaceSettings.iconImageRemove")}</Button>
        )}
      </div>

      {/* Space-scoped share link (#104): a view-only link to the whole space. */}
      <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", marginBottom: 6 }}>{t("spaceSettings.shareLabel")}</label>
      <p style={{ color: "var(--fg-dim)", fontSize: 13, marginTop: 0 }}>{t("spaceSettings.shareHint")}</p>
      <div style={{ marginBottom: 32 }}>
        <Button variant="default" onClick={() => setSharing(true)} data-testid="space-share">{t("spaceSettings.shareSpace")}</Button>
      </div>

      {/* #277 / ADR-116: space public toggle — only rendered while the tenant parent switch is ON.
          Copy states the exact exposure (public ∩ published ∩ not-private) and warns that per-page
          "restrict" does NOT hide a page from the public tree (only private does) — review condition ②. */}
      {surfaceOn && (
        <>
          <label style={{ display: "block", fontSize: 13, color: "var(--fg-dim)", marginBottom: 6 }}>{t("spaceSettings.publicLabel")}</label>
          <div style={{ marginBottom: 32 }} className="rounded-md border border-border p-3" data-testid="space-public-section">
            <label className="flex items-start gap-2">
              {/* #389 / ADR-146: bare checkbox → DS Switch (on/off state). */}
              <Switch
                className="mt-0.5"
                testId="space-public-toggle"
                checked={!!isPublic}
                disabled={setPublic.isPending}
                onChange={applyPublic}
              />
              <span>
                <span className="block text-sm text-foreground">{t("spaceSettings.publicTitle")}</span>
                <span className="block text-xs text-fg-dim">
                  {isPublic ? t("spaceSettings.publicOnHint") : t("spaceSettings.publicHint")}
                </span>
                <span className="block text-xs text-fg-dim">{t("spaceSettings.publicRestrictNote")}</span>
              </span>
            </label>
            {isPublic && (
              <div className="mt-2 flex items-center gap-2" data-testid="space-public-url-row">
                <Input inputSize="sm" readOnly className="min-w-0 flex-1 font-mono text-xs" value={publicUrl} data-testid="space-public-url" aria-label={t("spaceSettings.publicUrlLabel")} onFocus={(e) => e.currentTarget.select()} />
                <Button variant="default" size="sm" data-testid="space-public-url-copy" onClick={copyPublicUrl}>{t("permissions.copyUrl")}</Button>
              </div>
            )}
          </div>
        </>
      )}

      <h3 style={{ color: "var(--danger)" }}>{t("spaceSettings.dangerZone")}</h3>
      <p style={{ color: "var(--fg-dim)", fontSize: 13 }}>{t("spaceSettings.deleteHint")}</p>
      <Button variant="danger" onClick={() => setConfirming(true)} data-testid="space-delete">{t("spaceSettings.deleteSpace")}</Button>

      <ShareDialog spaceId={sharing ? spaceId : null} onClose={() => setSharing(false)} />

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
      <Route path="pages" element={<SpacePagesTab />} />
    </Route>
  );
}
