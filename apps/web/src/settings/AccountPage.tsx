import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { IdCard, SquarePen, Palette, HardDriveDownload, Loader2, Bell, KeyRound, Zap, Code, Eye, BookOpen, MonitorSmartphone } from "lucide-react"; // #493: display-mode glyphs
import { AppShell } from "../app/AppShell";
import { LoginScreen } from "../app/LoginScreen";
import { useSession } from "../session/SessionProvider";
import { useTheme, type Theme } from "../app/ThemeProvider";
import { useFontBody, type FontBody } from "../app/FontProvider";
import { useTocPref } from "../toc/useTocPref";
import { AccentPicker } from "./AccentPicker";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { shortPrincipalId } from "../ui/principal-label"; // #578: your own id, readable
import { Input } from "../ui/Input";
import { RadioGroup } from "../ui/RadioGroup";
import { CheckboxRow } from "../ui/Checkbox";
import { SwitchRow } from "../ui/Switch";
import { notify } from "../ui/toast";
import { useAccountSettings, useUpdateAccountSettings, useUploadAvatar, useRemoveAvatar, useMyApiKeys, useMyApiKeyPolicy, useMyActivity } from "../data/queries";
import { ActivityHeatmap } from "./ActivityHeatmap"; // #483 / ADR-180: personal contribution heatmap
import { ApiKeysPanel } from "./ApiKeysPanel"; // #462: shared with the admin console's key list
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
    // #362notification preferences live in SETTINGS ; the watch LIST lives
    // off the bell. Both are emission-narrowing member prefs — display authz is server-side regardless.
    { key: "notifications", label: t("accountNav.notifications"), to: "/settings/account/notifications", icon: Bell },
    // #462: a member's own API keys. They were only issuable from the admin console, so a member who
    // wanted to automate something had to ask an admin — while the server had always accepted their
    // request. The tenant can still restrict issuing to admins; then this tab lists what they hold
    // and offers no form.
    { key: "api-keys", label: t("accountNav.apiKeys"), to: "/settings/account/api-keys", icon: KeyRound },
    { key: "data", label: t("accountNav.data"), to: "/settings/account/data", icon: HardDriveDownload },
  ];
}

// #194 (A / ADR-052) → #466: a settings page shell — the readable column with a page heading +
// description. The per-group CARD (surface-2 + hairline border + radius) is GONE: every other
// settings screen (tenant branding / spaces / members / roles) groups with a heading + spacing on a
// plain surface, and the cards made this one screen read as a different product. Token-driven;
// visual only.
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
// #466: a plain section — no card chrome. The vertical rhythm comes from the shell's flex gap plus
// this bottom margin, matching the other settings tabs; every data-testid is preserved so the
// existing account e2e keeps targeting the same nodes.
function SettingsCard({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <section className="mb-2" data-testid={testid}>{children}</section>
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
        {/* #523 / ADR-190 (slice C): an OIDC-sourced user's name is managed by their identity provider
            authoritative, anti-impersonation — so it is READ-ONLY here (the server also refuses the write).
            Only a 'local' user may edit it. The override UI is retained, gated to local users. */}
        {settings.data && settings.data.identitySource !== "local" ? (
          <>
            <p className="mb-2 text-xs text-fg-dim">{t("account.displayNameIdpManaged")}</p>
            <p className="text-sm font-medium" data-testid="account-name-readonly">{settings.data.oidcDisplayName ?? (sub ? shortPrincipalId(sub) : "")}</p>
          </>
        ) : (
          <>
            <p className="mb-2 text-xs text-fg-dim">{t("account.displayNameHint")}</p>
            <div className="flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={settings.data?.oidcDisplayName ?? (sub ? shortPrincipalId(sub) : "")}
                data-testid="account-name-input"
              />
              <Button onClick={saveName} disabled={update.isPending} data-testid="account-name-save">{t("common.save")}</Button>
            </div>
            {settings.data?.displayNameOverride != null && (
              <button type="button" className="mt-2 text-xs text-fg-dim underline hover:text-foreground" onClick={resetName} data-testid="account-name-reset">
                {t("account.resetToIdp", { name: settings.data?.oidcDisplayName ?? (sub ? shortPrincipalId(sub) : "") })}
              </button>
            )}
          </>
        )}
      </SettingsCard>

      <SettingsCard>
        <label className="mb-1 block text-sm font-medium">{t("account.avatar")}</label>
        <p className="mb-2 text-xs text-fg-dim">{t("account.avatarHint")}</p>
        <div className="flex items-center gap-3">
          <Avatar
            /* #578: `name` here drives the INITIALS drawn in the chip, so a raw id put two hex
               characters where a person's letters belong. The short id gives the same two, from
               something a reader can also match against the id shown above. */
            name={displayName ?? (sub ? shortPrincipalId(sub) : "")}
            src={picture}
            seed={sub ?? "" /* raw-principal-ok: a colour seed, never rendered */}
            size={48}
            data-testid="account-avatar"
          />
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
            // #504: red at rest; no confirm — re-uploading restores it in one step (exception candidate)
            <Button variant="dangerGhost" onClick={() => removeAvatar.mutate(undefined, { onSuccess: () => { void refresh(); }, onError: () => notify.error(t("toast.actionFailed")) })} disabled={removeAvatar.isPending} data-testid="account-avatar-remove">
              {t("account.removeAvatar")}
            </Button>
          )}
        </div>
      </SettingsCard>

      <SettingsCard testid="account-activity">
        <label className="mb-1 block text-sm font-medium">{t("account.activityTitle")}</label>
        <p className="mb-3 text-xs text-fg-dim">{t("account.activityHint")}</p>
        <ActivitySection />
      </SettingsCard>
    </SettingsPage>
    </div>
  );
}

// #483 / ADR-180: the caller's own contribution heatmap over the last ~12 months. Self-only (the server
// resolves the sub from the session), CE, no new store. Buckets follow the browser's timezone.
function ActivitySection() {
  const { t } = useTranslation();
  const tz = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } }, []);
  const activity = useMyActivity(tz);
  if (activity.isError) return <p className="text-xs text-fg-dim">{t("account.activityFailed")}</p>;
  if (activity.isLoading || !activity.data) return <div className="h-[98px] w-full animate-pulse rounded bg-panel-2 motion-reduce:animate-none" aria-hidden="true" />;
  return <ActivityHeatmap days={activity.data.days} />;
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

      <SettingsCard testid="account-atom-policy">
        {/* #395A: the ADR-156 atom/typed-body policy line, on a surface EVERY user can reach
            the onboarding done-screen shows it only on first run, so existing members never saw it.
            Reuses the onboarding string: one source of truth for the policy wording. */}
        <label className="mb-1 block text-sm font-medium">{t("account.selectionModel")}</label>
        <p className="text-xs text-fg-dim">{t("onboarding.atomHint")}</p>
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
          options={(["local", "live", "source", "wysiwyg"] as const).map((m) => ({
          value: m,
          label: t(`account.displayMode_${m}`),
          // #493: the same per-mode glyphs the editor chrome uses — local follows the device (no fixed
          // face), live=Zap (instant), source=Code (raw), wysiwyg=Eye (see-what-you-get).
          icon: { local: <MonitorSmartphone />, live: <Zap />, source: <Code />, wysiwyg: <Eye /> }[m],
        }))}
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
              // #493same per-mode glyphs as the displayMode RadioGroup above / MODE_META
              // every surface that enumerates the modes shows the same icons.
              icon={{ live: <Zap />, source: <Code />, reading: <BookOpen />, wysiwyg: <Eye /> }[m]}
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

// #362 / ADR-126 addendum: notification preferences — the global kill switch + the default event mask
// a mask-less watch inherits (mention included here: it is a direct address, not a subscription, so it
// has no per-watch mask). Server-side these only NARROW fan-out; display gating is untouched.
const DEFAULT_MASK_TYPES = [
  "page.published",
  "page.restored",
  "comment.created",
  "attachment.confirmed",
  "page.made_public",
  "page.made_non_public",
  "mention",
] as const;
function NotificationsTab() {
  const { t } = useTranslation();
  const settings = useAccountSettings();
  const update = useUpdateAccountSettings();
  const enabled = settings.data?.notificationsEnabled ?? true;
  const mask = settings.data?.defaultEventMask ?? [];
  const all = mask.length === 0;
  const toggleType = (type: string) => {
    const current = all ? [...DEFAULT_MASK_TYPES] : mask;
    const next = current.includes(type) ? current.filter((x) => x !== type) : [...current, type];
    update.mutate({ defaultEventMask: next.length === DEFAULT_MASK_TYPES.length ? [] : next });
  };
  return (
    <SettingsPage title={t("account.notifications.title")} description={t("account.notifications.desc")}>
      <SettingsCard testid="notifications-enabled-card">
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="text-[length:var(--text-ui)] text-foreground">{t("account.notifications.enabled")}</span>
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={update.isPending || settings.isLoading}
            onChange={(e) => update.mutate({ notificationsEnabled: e.target.checked })}
            data-testid="notifications-enabled"
          />
        </label>
        <p className="mb-0 mt-1 text-[length:var(--text-xs)] text-fg-dim">{t("account.notifications.enabledHint")}</p>
      </SettingsCard>
      {/* #547 / ADR-196 §3: email delivery — both under the kill switch above (fan-out enforces). */}
      <SettingsCard testid="email-prefs-card">
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="text-[length:var(--text-ui)] text-foreground">{t("account.notifications.emailImmediate")}</span>
          <input
            type="checkbox"
            role="switch"
            checked={settings.data?.emailImmediate ?? true}
            disabled={update.isPending || settings.isLoading || !enabled}
            onChange={(e) => update.mutate({ emailImmediate: e.target.checked })}
            data-testid="email-immediate"
          />
        </label>
        <p className="mb-2 mt-1 text-[length:var(--text-xs)] text-fg-dim">{t("account.notifications.emailImmediateHint")}</p>
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="text-[length:var(--text-ui)] text-foreground">{t("account.notifications.emailDigest")}</span>
          <input
            type="checkbox"
            role="switch"
            checked={settings.data?.emailDigest ?? false}
            disabled={update.isPending || settings.isLoading || !enabled}
            onChange={(e) => update.mutate({ emailDigest: e.target.checked })}
            data-testid="email-digest"
          />
        </label>
        <p className="mb-0 mt-1 text-[length:var(--text-xs)] text-fg-dim">{t("account.notifications.emailDigestHint")}</p>
      </SettingsCard>
      <SettingsCard testid="notifications-mask-card">
        <div className="mb-2 text-[length:var(--text-ui)] text-foreground">{t("account.notifications.defaultMask")}</div>
        <p className="mb-3 text-[length:var(--text-xs)] text-fg-dim">{t("account.notifications.defaultMaskHint")}</p>
        <div className="flex flex-col gap-1.5">
          {DEFAULT_MASK_TYPES.map((type) => (
            <label key={type} className="inline-flex cursor-pointer items-center gap-2 text-[length:var(--text-ui)] text-foreground">
              <input
                type="checkbox"
                checked={all || mask.includes(type)}
                disabled={update.isPending || settings.isLoading || !enabled}
                onChange={() => toggleType(type)}
                data-testid={`default-mask-${type}`}
              />
              {t(`eventTypes.${type}`)}
            </label>
          ))}
        </div>
      </SettingsCard>
    </SettingsPage>
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
// #462: a member's own API keys — issue, see, revoke. What is offered here depends on the tenant's
// issuing policy, but only for the affordance: the server refuses an unauthorised issue regardless
// of what this screen shows, and the list it renders is owner-scoped server-side.
function ApiKeysTab() {
  const { t } = useTranslation();
  const policy = useMyApiKeyPolicy();
  const keys = useMyApiKeys();
  const canIssue = policy.data?.canIssue ?? false;
  return (
    <SettingsPage title={t("accountApiKeys.title")} description={t("accountApiKeys.body")}>
      <div data-testid="account-api-keys">
        {policy.data && !canIssue && (
          <p className="mt-0 text-sm text-fg-dim" data-testid="api-keys-restricted">{t("accountApiKeys.restricted")}</p>
        )}
        <ApiKeysPanel
          keys={keys.data ?? []}
          canIssue={canIssue}
          maxScope={policy.data?.maxScope ?? "write"}
          emptyText={t("accountApiKeys.empty")}
        />
      </div>
    </SettingsPage>
  );
}

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

// #489: code-split — a nested <Routes> (paths relative to the /settings/account/* mount) so the module
// lazy-loads out of the eager bundle. Same paths, same layout.
export function AccountRoot() {
  return (
    <Routes>
      <Route element={<AccountLayout />}>
        <Route index element={<ProfileTab />} />
        <Route path="editor" element={<EditorTab />} />
        <Route path="theme" element={<ThemeTab />} />
        <Route path="notifications" element={<NotificationsTab />} />
        <Route path="api-keys" element={<ApiKeysTab />} />
        <Route path="data" element={<DataTab />} />
        <Route path="*" element={<Navigate to="/settings/account" replace />} />
      </Route>
    </Routes>
  );
}
