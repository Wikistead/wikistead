import { useEffect, useRef, useState } from "react";
import { Navigate, Outlet, Route } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppShell } from "../app/AppShell";
import { LoginScreen } from "../app/LoginScreen";
import { useSession } from "../session/SessionProvider";
import { useTheme, type Theme } from "../app/ThemeProvider";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { notify } from "../ui/toast";
import { useAccountSettings, useUpdateAccountSettings, useUploadAvatar, useRemoveAvatar } from "../data/queries";
import { SettingsShell, type SettingsTab } from "./SettingsShell";

// Personal account settings (ADR-020, Design-6). Self-scope: the server keys every
// read/write to the authenticated member (WHERE sub = req.user.sub) — not an FGA ACL.
// Tabs: Profile (name override + avatar), Editor (keymap), Theme (REUSES useTheme, the
// existing device-local control — no new mechanism).

function useAccountTabs(): SettingsTab[] {
  const { t } = useTranslation();
  return [
    { key: "profile", label: t("accountNav.profile"), to: "/settings/account" },
    { key: "editor", label: t("accountNav.editor"), to: "/settings/account/editor" },
    { key: "theme", label: t("accountNav.theme"), to: "/settings/account/theme" },
  ];
}

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(",") + 1)); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });

function ProfileTab() {
  const { t } = useTranslation();
  const { sub, displayName, picture, refresh } = useSession();
  const settings = useAccountSettings();
  const update = useUpdateAccountSettings();
  const uploadAvatar = useUploadAvatar();
  const removeAvatar = useRemoveAvatar();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");

  // Seed the field from the override once settings load (empty = using the IdP name).
  useEffect(() => { setName(settings.data?.displayNameOverride ?? ""); }, [settings.data?.displayNameOverride]);

  const saveName = () =>
    update.mutate({ displayNameOverride: name }, {
      onSuccess: () => { void refresh(); notify.success(t("toast.saved")); },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  const resetName = () =>
    update.mutate({ displayNameOverride: null }, {
      onSuccess: () => { setName(""); void refresh(); notify.success(t("toast.saved")); },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  const onPick = async (file: File | undefined) => {
    if (!file) return;
    try {
      await uploadAvatar.mutateAsync(await fileToBase64(file));
      void refresh();
      notify.success(t("toast.saved"));
    } catch { notify.error(t("toast.actionFailed")); }
  };

  return (
    <div className="max-w-[560px] px-6 py-8" data-testid="account-profile">
      <h2 className="mt-0 text-foreground">{t("accountNav.profile")}</h2>

      <section className="mb-8">
        <label className="mb-1 block text-sm font-medium">{t("account.displayName")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.displayNameHint")}</p>
        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={settings.data?.oidcDisplayName ?? sub ?? ""}
            data-testid="account-name-input"
          />
          <Button onClick={saveName} disabled={update.isPending} data-testid="account-name-save">{t("common.save")}</Button>
        </div>
        {settings.data?.displayNameOverride != null && (
          <button type="button" className="mt-2 text-xs text-fg-dim underline hover:text-foreground" onClick={resetName} data-testid="account-name-reset">
            {t("account.resetToIdp", { name: settings.data?.oidcDisplayName ?? sub ?? "" })}
          </button>
        )}
      </section>

      <section>
        <label className="mb-1 block text-sm font-medium">{t("account.avatar")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.avatarHint")}</p>
        <div className="flex items-center gap-3">
          <Avatar name={displayName ?? sub ?? ""} src={picture} seed={sub ?? ""} size={48} data-testid="account-avatar" />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            data-testid="account-avatar-input"
            onChange={(e) => { void onPick(e.target.files?.[0]); e.target.value = ""; }}
          />
          <Button variant="default" onClick={() => fileRef.current?.click()} disabled={uploadAvatar.isPending} data-testid="account-avatar-upload">
            {t("account.uploadAvatar")}
          </Button>
          {settings.data?.hasAvatar && (
            <Button variant="ghost" onClick={() => removeAvatar.mutate(undefined, { onSuccess: () => { void refresh(); }, onError: () => notify.error(t("toast.actionFailed")) })} disabled={removeAvatar.isPending} data-testid="account-avatar-remove">
              {t("account.removeAvatar")}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

function EditorTab() {
  const { t } = useTranslation();
  const settings = useAccountSettings();
  const update = useUpdateAccountSettings();
  const keymap = settings.data?.editorKeymap ?? "default";
  // Writes the cross-device default (server) AND this device's local cache, so the editor
  // on this device reflects the choice on its next mount (the toolbar toggle is otherwise
  // device-local — ADR-020 D4).
  const choose = (km: "default" | "vim") => {
    try { localStorage.setItem("wks.editorVim", km === "vim" ? "1" : "0"); } catch { /* no storage */ }
    update.mutate({ editorKeymap: km });
  };
  return (
    <div className="max-w-[560px] px-6 py-8" data-testid="account-editor">
      <h2 className="mt-0 text-foreground">{t("accountNav.editor")}</h2>
      <label className="mb-1 block text-sm font-medium">{t("account.keymap")}</label>
      <p className="mb-2 text-xs text-fg-dim">{t("account.keymapHint")}</p>
      <div className="flex gap-2">
        {(["default", "vim"] as const).map((km) => (
          <Button
            key={km}
            variant={keymap === km ? "primary" : "default"}
            onClick={() => choose(km)}
            data-testid={`account-keymap-${km}`}
            aria-pressed={keymap === km}
          >
            {t(`account.keymap_${km}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ThemeTab() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme(); // reuse the existing device-local control
  return (
    <div className="max-w-[560px] px-6 py-8" data-testid="account-theme">
      <h2 className="mt-0 text-foreground">{t("accountNav.theme")}</h2>
      <p className="mb-2 text-xs text-fg-dim">{t("account.themeHint")}</p>
      <div className="flex gap-2">
        {(["light", "dark", "system"] as const).map((th: Theme) => (
          <Button
            key={th}
            variant={theme === th ? "primary" : "default"}
            onClick={() => setTheme(th)}
            data-testid={`account-theme-${th}`}
            aria-pressed={theme === th}
          >
            {t(`account.theme_${th}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}

function AccountLayout() {
  const { t } = useTranslation();
  const { status, logout } = useSession();
  const tabs = useAccountTabs();
  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  return (
    <AppShell onLogout={logout}>
      <SettingsShell title={t("accountNav.title")} tabs={tabs}>
        <Outlet />
      </SettingsShell>
    </AppShell>
  );
}

// Inline <Route> elements so the parent <Routes> can parse them.
export function AccountRoutes() {
  return (
    <Route path="/settings/account" element={<AccountLayout />}>
      <Route index element={<ProfileTab />} />
      <Route path="editor" element={<EditorTab />} />
      <Route path="theme" element={<ThemeTab />} />
      <Route path="*" element={<Navigate to="/settings/account" replace />} />
    </Route>
  );
}
