import { useEffect, useRef, useState } from "react";
import { Navigate, Outlet, Route } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppShell } from "../app/AppShell";
import { LoginScreen } from "../app/LoginScreen";
import { useSession } from "../session/SessionProvider";
import { useTheme, type Theme } from "../app/ThemeProvider";
import { useFontBody, type FontBody } from "../app/FontProvider";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { notify } from "../ui/toast";
import { useAccountSettings, useUpdateAccountSettings, useUploadAvatar, useRemoveAvatar } from "../data/queries";
import { COMMANDS, resolveKey, chordFromEvent, displayChord, validateAssignment, type Keybindings, type CommandDef } from "../app/keybindings";
import { SettingsShell, type SettingsTab } from "./SettingsShell";

// Personal account settings (ADR-020, Design-6). Self-scope: the server keys every
// read/write to the authenticated member (WHERE sub = req.user.sub) — not an FGA ACL.
// Tabs: Profile (name override + avatar), Editor (keymap), Theme (REUSES useTheme, the
// existing device-local control — no new mechanism).

function useAccountTabs(): SettingsTab[] {
  const { t } = useTranslation();
  return [
    { key: "profile", label: t("accountNav.profile"), to: "/settings/account", end: true },
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

// One remappable shortcut (ADR-021). "Change" captures the next chord via event.code
// (capture phase, so it beats the app's own handlers + vim); validates client-side
// (mirrors the server bastion) and saves the override; "Reset" clears it.
function ShortcutRow({ cmd, keybindings, onSave, onReset }: { cmd: CommandDef; keybindings: Keybindings; onSave: (id: string, chord: string) => void; onReset: (id: string) => void }) {
  const { t } = useTranslation();
  const [capturing, setCapturing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const current = resolveKey(cmd.id, keybindings);
  const overridden = keybindings[cmd.id] != null;

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturing(false); setErr(null); return; }
      const chord = chordFromEvent(e);
      if (!chord) return; // modifier-only — keep waiting for a real key
      const error = validateAssignment(cmd.id, chord, keybindings);
      if (error) { setErr(error); return; }
      setCapturing(false);
      setErr(null);
      onSave(cmd.id, chord);
    };
    window.addEventListener("keydown", onKey, true); // capture phase: beat app/vim handlers
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, cmd.id, keybindings, onSave]);

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2" data-testid={`kb-row-${cmd.id}`}>
      <span className="text-sm">{t(cmd.labelKey)}</span>
      <div className="flex items-center gap-2">
        {capturing ? (
          <span className={`text-xs ${err ? "text-[var(--danger)]" : "text-fg-dim"}`} data-testid="kb-capturing">{err ? t(err) : t("account.kbPress")}</span>
        ) : (
          <kbd className="rounded border border-border bg-panel-2 px-1.5 py-0.5 text-xs" data-testid={`kb-current-${cmd.id}`}>{displayChord(current)}</kbd>
        )}
        <Button size="sm" onClick={() => { setErr(null); setCapturing((c) => !c); }} data-testid={`kb-change-${cmd.id}`}>{capturing ? t("common.cancel") : t("account.kbChange")}</Button>
        {overridden && !capturing && <Button size="sm" variant="ghost" onClick={() => onReset(cmd.id)} data-testid={`kb-reset-${cmd.id}`}>{t("account.kbReset")}</Button>}
      </div>
    </div>
  );
}

function EditorTab() {
  const { t } = useTranslation();
  const settings = useAccountSettings();
  const update = useUpdateAccountSettings();
  const mode = settings.data?.editorKeymap ?? "local";
  const dmode = settings.data?.editorDisplayMode ?? "local"; // ADR-056 / #164 startup display mode
  const kb = settings.data?.keybindings ?? {};
  const { fontBody, setFontBody } = useFontBody(); // #190 / ADR-090: device-local body-font override
  // Startup-mode preference (cross-device, server). 'local' follows this device's last
  // toolbar toggle; 'vim'/'default' force the startup state. The toolbar toggle
  // (Ctrl+Alt+V) still switches within a session regardless.
  const choose = (m: "local" | "vim" | "default") => update.mutate({ editorKeymap: m });
  const saveKb = (id: string, chord: string) => update.mutate({ keybindings: { ...kb, [id]: chord } });
  const resetKb = (id: string) => { const next = { ...kb }; delete next[id]; update.mutate({ keybindings: next }); };
  return (
    <div className="max-w-[560px] px-6 py-8" data-testid="account-editor">
      <h2 className="mt-0 text-foreground">{t("accountNav.editor")}</h2>
      <label className="mb-1 block text-sm font-medium">{t("account.keymap")}</label>
      <p className="mb-2 text-xs text-fg-dim">{t("account.keymapHint")}</p>
      <div className="flex flex-col gap-2">
        {(["local", "vim", "default"] as const).map((m) => (
          <Button
            key={m}
            variant={mode === m ? "primary" : "default"}
            onClick={() => choose(m)}
            data-testid={`account-keymap-${m}`}
            aria-pressed={mode === m}
            className="justify-start"
          >
            {t(`account.keymap_${m}`)}
          </Button>
        ))}
      </div>

      <section className="mt-8">
        {/* ADR-056 / #164: startup display mode (live/source/local), orthogonal to the keymap. */}
        <label className="mb-1 block text-sm font-medium">{t("account.displayMode")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.displayModeHint")}</p>
        <div className="flex flex-col gap-2">
          {(["local", "live", "source"] as const).map((m) => (
            <Button
              key={m}
              variant={dmode === m ? "primary" : "default"}
              onClick={() => update.mutate({ editorDisplayMode: m })}
              data-testid={`account-displaymode-${m}`}
              aria-pressed={dmode === m}
              className="justify-start"
            >
              {t(`account.displayMode_${m}`)}
            </Button>
          ))}
        </div>
      </section>

      <section className="mt-8">
        {/* #190 / ADR-090: personal body-font override (device-local). "locale" follows the UI
            language default (JP=UDEV Gothic, EN=Wikistead Mono); the others force a face. */}
        <label className="mb-1 block text-sm font-medium">{t("account.bodyFont")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.bodyFontHint")}</p>
        <div className="flex flex-col gap-2">
          {(["locale", "udev", "mono"] as const).map((f) => (
            <Button
              key={f}
              variant={fontBody === f ? "primary" : "default"}
              onClick={() => setFontBody(f)}
              data-testid={`account-bodyfont-${f}`}
              aria-pressed={fontBody === f}
              className="justify-start"
            >
              {t(`account.bodyFont_${f}`)}
            </Button>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <label className="mb-1 block text-sm font-medium">{t("account.shortcuts")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.shortcutsHint")}</p>
        <div className="flex flex-col gap-2">
          {COMMANDS.map((c) => <ShortcutRow key={c.id} cmd={c} keybindings={kb} onSave={saveKb} onReset={resetKb} />)}
        </div>
      </section>
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
