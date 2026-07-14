import { useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, Outlet, Route } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { IdCard, SquarePen, Palette, HardDriveDownload, Loader2 } from "lucide-react";
import { AppShell } from "../app/AppShell";
import { LoginScreen } from "../app/LoginScreen";
import { useSession } from "../session/SessionProvider";
import { useTheme, type Theme } from "../app/ThemeProvider";
import { useFontBody, type FontBody } from "../app/FontProvider";
import { useTocPref } from "../toc/useTocPref";
import { AccentPicker } from "./AccentPicker";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { RadioGroup } from "../ui/RadioGroup";
import { CheckboxRow } from "../ui/Checkbox";
import { SwitchRow } from "../ui/Switch";
import { notify } from "../ui/toast";
import { useAccountSettings, useUpdateAccountSettings, useUploadAvatar, useRemoveAvatar } from "../data/queries";
import { downloadTenantExport } from "../data/exportApi"; // #309: whole-tenant Markdown-ZIP export
import { EditorOnboardingDialog } from "../app/EditorOnboarding"; // #289: "redo the setup questions"
import { COMMANDS, resolveKey, chordFromEvent, displayChord, validateAssignment, type Keybindings, type CommandDef } from "../app/keybindings";
import { SettingsShell, type SettingsTab } from "./SettingsShell";

// Personal account settings (ADR-020, Design-6). Self-scope: the server keys every
// read/write to the authenticated member (WHERE sub = req.user.sub) — not an FGA ACL.
// Tabs: Profile (name override + avatar), Editor (keymap), Theme (REUSES useTheme, the
// existing device-local control — no new mechanism).

function useAccountTabs(): SettingsTab[] {
  const { t } = useTranslation();
  return [
    { key: "profile", label: t("accountNav.profile"), to: "/settings/account", end: true, icon: IdCard },
    { key: "editor", label: t("accountNav.editor"), to: "/settings/account/editor", icon: SquarePen },
    { key: "theme", label: t("accountNav.theme"), to: "/settings/account/theme", icon: Palette },
    // #309: the Data section hosts the tenant-wide export. It lives HERE (personal settings), not in
    // the tenant /admin console, because the export is view-filtered per member — every member may
    // take their visible knowledge out (Open formats), so an admin-looking home would misstate it.
    { key: "data", label: t("accountNav.data"), to: "/settings/account/data", icon: HardDriveDownload },
  ];
}

// #194 (A / ADR-052): a settings page shell — a centered column with a page heading + description,
// and each setting grouped into a card (surface-2, hairline border, 12px radius) so the screen reads
// structured (Linear-style) rather than bare full-width rows. Token-driven; visual only.
function SettingsPage({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    // #194 (revised): the readable column is LEFT-aligned right after the rail (NO mx-auto — the
    // earlier centering was the bug), IDENTICAL to the space/admin tabs (max-w-[560px] p-6) so every
    // settings screen has the exact same layout. max-width caps line length for readability.
    <div className="max-w-[560px] p-6">
      <h2 className="mt-0 mb-1 text-[length:var(--text-xl)] font-medium text-foreground">{title}</h2>
      {description && <p className="mb-6 text-[length:var(--text-ui)] text-fg-dim">{description}</p>}
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}
function SettingsCard({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <section className="rounded-xl border border-border bg-panel-2 p-5" data-testid={testid}>{children}</section>
  );
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
    <div data-testid="account-profile">
    <SettingsPage title={t("accountNav.profile")} description={t("account.profileHint")}>
      <SettingsCard>
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
      </SettingsCard>

      <SettingsCard>
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
      </SettingsCard>
    </SettingsPage>
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
  const { on: tocOn, setOn: setTocOn, depth: tocDepth, setDepth: setTocDepth } = useTocPref(); // #192: TOC on/off + depth moved here from the rail
  // Startup-mode preference (cross-device, server). 'local' follows this device's last
  // toolbar toggle; 'vim'/'default' force the startup state. The toolbar toggle
  // (Ctrl+Alt+V) still switches within a session regardless.
  const choose = (m: "local" | "vim" | "default") => update.mutate({ editorKeymap: m });
  const saveKb = (id: string, chord: string) => update.mutate({ keybindings: { ...kb, [id]: chord } });
  const resetKb = (id: string) => { const next = { ...kb }; delete next[id]; update.mutate({ keybindings: next }); };
  // #289 / ADR-115: chrome visibility (vim button + per-mode). null (never enrolled) = all shown.
  // The last visible mode can't be hidden (never strand the user with an empty switch).
  const chrome = settings.data?.editorChrome ?? null;
  const modesVisible = chrome?.modesVisible ?? { live: true, source: true, reading: true, wysiwyg: true };
  const vimToggleVisible = chrome?.vimToggleVisible ?? true;
  const writeChrome = (next: { vimToggleVisible: boolean; modesVisible: typeof modesVisible }) => update.mutate({ editorChrome: next });
  const toggleMode = (m: keyof typeof modesVisible) => {
    const next = { ...modesVisible, [m]: !modesVisible[m] };
    if (!Object.values(next).some(Boolean)) return; // keep at least one mode
    writeChrome({ vimToggleVisible, modesVisible: next });
  };
  const [redoOpen, setRedoOpen] = useState(false); // "redo the setup questions" (ADR-115 §5)
  return (
    <div data-testid="account-editor">
    <SettingsPage title={t("accountNav.editor")} description={t("account.editorHint")}>
      <SettingsCard>
      <label className="mb-1 block text-sm font-medium">{t("account.keymap")}</label>
      <p className="mb-2 text-xs text-fg-dim">{t("account.keymapHint")}</p>
      {/* #389 / ADR-146: a real radiogroup (list look) — was a row of highlighted buttons. */}
      <RadioGroup
        value={mode}
        onChange={(v) => choose(v as "local" | "vim" | "default")}
        ariaLabel={t("account.keymap")}
        testId="account-keymap"
        options={(["local", "vim", "default"] as const).map((m) => ({ value: m, label: t(`account.keymap_${m}`) }))}
      />
      </SettingsCard>

      <SettingsCard>
        {/* ADR-056 / #164: startup display mode, orthogonal to the keymap. #289 added wysiwyg to
            the startup set (reading stays a mid-session state, not a startup value). */}
        <label className="mb-1 block text-sm font-medium">{t("account.displayMode")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.displayModeHint")}</p>
        <RadioGroup
          value={dmode}
          onChange={(v) => update.mutate({ editorDisplayMode: v as "local" | "live" | "source" | "wysiwyg" })}
          ariaLabel={t("account.displayMode")}
          testId="account-displaymode"
          options={(["local", "live", "source", "wysiwyg"] as const).map((m) => ({ value: m, label: t(`account.displayMode_${m}`) }))}
        />
      </SettingsCard>

      <SettingsCard testid="account-chrome">
        {/* #289 / ADR-115: editor chrome visibility — which controls show. Display-only; hiding the
            vim button never disables vim (Ctrl+Alt+V + the keymap setting above stay the recovery). */}
        <label className="mb-1 block text-sm font-medium">{t("account.chrome")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.chromeHint")}</p>
        {/* #389 / ADR-146: on/off state → Switch; the per-mode opt-ins → real checkboxes. */}
        <div className="mb-3">
          <SwitchRow
            checked={vimToggleVisible}
            onChange={(v) => writeChrome({ vimToggleVisible: v, modesVisible })}
            testId="account-chrome-vim"
            label={t(vimToggleVisible ? "account.chromeVimShown" : "account.chromeVimHidden")}
          />
        </div>
        <p className="mb-2 text-xs text-fg-dim">{t("account.chromeModesHint")}</p>
        <div className="flex flex-col gap-2">
          {(["live", "source", "reading", "wysiwyg"] as const).map((m) => (
            <CheckboxRow
              key={m}
              checked={modesVisible[m]}
              onChange={() => toggleMode(m)}
              testId={`account-chrome-mode-${m}`}
              label={t(`page.mode${m === "live" ? "Live" : m === "source" ? "Source" : m === "reading" ? "Reading" : "Wysiwyg"}`)}
            />
          ))}
        </div>
        <div className="mt-3">
          <Button variant="ghost" data-testid="account-chrome-redo" onClick={() => setRedoOpen(true)}>
            {t("account.chromeRedo")}
          </Button>
        </div>
        <EditorOnboardingDialog open={redoOpen} onClose={() => setRedoOpen(false)} />
      </SettingsCard>

      <SettingsCard>
        {/* #190 / ADR-090: personal body-font override (device-local). "locale" follows the UI
            language default (JP=UDEV Gothic, EN=Wikistead Mono); the others force a face. */}
        <label className="mb-1 block text-sm font-medium">{t("account.bodyFont")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.bodyFontHint")}</p>
        <RadioGroup
          value={fontBody}
          onChange={(v) => setFontBody(v as FontBody)}
          ariaLabel={t("account.bodyFont")}
          testId="account-bodyfont"
          options={(["locale", "udev", "mono", "sans"] as const).map((f) => ({ value: f, label: t(`account.bodyFont_${f}`) }))}
        />
      </SettingsCard>

      <SettingsCard>
        {/* #192 / ADR-091: table-of-contents on/off + depth (device-local). Moved out of the TOC rail
            so the rail stays clean; the rail just filters by this depth. */}
        <label className="mb-1 block text-sm font-medium">{t("account.toc")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.tocHint")}</p>
        {/* #389 / ADR-146: on/off → Switch; the 3-value depth → segmented radios. */}
        <div className="mb-4">
          <SwitchRow
            checked={tocOn}
            onChange={setTocOn}
            testId="account-toc"
            label={t(tocOn ? "account.toc_on" : "account.toc_off")}
          />
        </div>
        <label className="mb-1 block text-sm font-medium">{t("account.tocDepth")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.tocDepthHint")}</p>
        <RadioGroup
          variant="segmented"
          value={String(tocDepth)}
          onChange={(v) => setTocDepth(Number(v) as 1 | 3 | 6)}
          ariaLabel={t("account.tocDepth")}
          testId="account-tocdepth"
          options={([1, 3, 6] as const).map((d) => ({ value: String(d), label: t(`account.tocDepth_${d}`) }))}
        />
      </SettingsCard>

      <SettingsCard>
        <label className="mb-1 block text-sm font-medium">{t("account.shortcuts")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.shortcutsHint")}</p>
        <div className="flex flex-col gap-2">
          {COMMANDS.map((c) => <ShortcutRow key={c.id} cmd={c} keybindings={kb} onSave={saveKb} onReset={resetKb} />)}
        </div>
      </SettingsCard>
    </SettingsPage>
    </div>
  );
}

function ThemeTab() {
  const { t } = useTranslation();
  const { theme, setTheme, accent, setAccent } = useTheme(); // device-local: light/dark AND personal accent (#201)
  return (
    <div data-testid="account-theme">
    <SettingsPage title={t("accountNav.theme")} description={t("account.themeHint")}>
      <SettingsCard>
      <label className="mb-1 block text-sm font-medium">{t("account.appearance")}</label>
      <p className="mb-2 text-xs text-fg-dim">{t("account.appearanceHint")}</p>
      {/* #389 / ADR-146: ≤4 short options → segmented radiogroup (the user-ruled default). */}
      <RadioGroup
        variant="segmented"
        value={theme}
        onChange={(v) => setTheme(v as Theme)}
        ariaLabel={t("account.appearance")}
        testId="account-theme"
        options={(["light", "dark", "system"] as const).map((th) => ({ value: th, label: t(`account.theme_${th}`) }))}
      />
      </SettingsCard>

      {/* #201: personal accent — device-local (like light/dark), overrides the tenant accent for THIS
          user only. Default = inherit the tenant accent (null). */}
      <SettingsCard>
        <label className="mb-1 block text-sm font-medium">{t("account.accent")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.accentHint")}</p>
        <AccentPicker value={accent} onChange={setAccent} inheritLabel={t("account.accentInherit")} />
      </SettingsCard>
    </SettingsPage>
    </div>
  );
}

// #309: Data — take your knowledge out. One card: export EVERYTHING this member can view as a
// Markdown ZIP (spaces as directories, images bundled). The button disables + spins while the
// server builds the archive; a 413 (over the size budget) gets its dedicated message.
function DataTab() {
  const { t } = useTranslation();
  const { token } = useSession();
  const [exporting, setExporting] = useState(false);
  const run = () => {
    if (exporting) return;
    setExporting(true);
    void downloadTenantExport(token).then((status) => {
      setExporting(false);
      if (status >= 200 && status < 300) notify.success(t("export.done"));
      else notify.error(t(status === 413 ? "export.tooLarge" : "toast.actionFailed"));
    });
  };
  return (
    <div data-testid="account-data">
      <SettingsPage title={t("accountNav.data")} description={t("account.dataHint")}>
        <SettingsCard testid="tenant-export-card">
          <label className="mb-1 block text-sm font-medium">{t("export.tenantTitle")}</label>
          <p className="mb-2 text-xs text-fg-dim">{t("export.tenantHint")}</p>
          <Button onClick={run} disabled={exporting} data-testid="tenant-export">
            {exporting && <Loader2 size={14} className="animate-spin" />} {t("export.tenantButton")}
          </Button>
        </SettingsCard>
      </SettingsPage>
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
      <Route path="data" element={<DataTab />} />
      <Route path="*" element={<Navigate to="/settings/account" replace />} />
    </Route>
  );
}
