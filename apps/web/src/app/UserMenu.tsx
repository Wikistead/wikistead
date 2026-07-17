import { useNavigate } from "react-router-dom";
import { Shield, LogOut, Settings, FileStack, Sun, Moon, Monitor, Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "../session/SessionProvider";
import { useTheme, type Theme } from "./ThemeProvider";
import { LANGS, setLang } from "../i18n";
import { Avatar } from "../ui/Avatar";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu";

// Header user menu (member chrome only — rendered when onLogout is provided).
// Hosts the tenant-admin entry (shown only when isAdmin — UI convenience; the
// server re-checks tenant#admin on every admin action) and Sign out.
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const THEME_ORDER: Theme[] = ["light", "dark", "system"];

export function UserMenu({ onLogout }: { onLogout: () => void }) {
  const { t, i18n } = useTranslation();
  const { isAdmin, displayName, picture, sub, user, devMode } = useSession();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const name = displayName ?? sub ?? t("userMenu.label");
  // #406 S1 (ADR-159 §3 header): below md the standalone header toggles fold in here — cycle theme /
  // switch language from the account menu. Hidden at md+ (the standalone toggles are back).
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!;
  const NextThemeIcon = THEME_ICON[theme];
  const currentLang = (i18n.resolvedLanguage ?? i18n.language) as (typeof LANGS)[number];
  const nextLang = LANGS[(LANGS.indexOf(currentLang) + 1) % LANGS.length] ?? LANGS[0]!;
  return (
    <>
    {/* #427 (b): make god-mode VISIBLE — while the dev-token bypass identity (dev-user) is
        active, show a DEV badge so it is never mistaken for a real logged-in identity. A real
        cookie session flips devMode off and the badge disappears. */}
    {devMode && (
      <span className="ml-2 rounded border border-border bg-panel-2 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-fg-dim" title={t("userMenu.devModeTitle")} data-testid="dev-mode-badge">
        DEV
      </span>
    )}
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger className="ml-2 flex cursor-pointer rounded-full p-0 leading-none transition-shadow hover:shadow-[0_0_0_2px_var(--panel-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-label={t("userMenu.label")} title={name} data-testid="user-menu">
        <Avatar name={name} src={picture} seed={user.seed ?? sub ?? name} size={26} data-testid="user-avatar" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="user-menu-content">
        {/* #406 S1: mobile-only rows — the folded theme/language controls (md+ shows the standalone
            header toggles instead). Theme cycles light→dark→system; language cycles the LANGS ring. */}
        <DropdownMenuItem className="md:hidden" onSelect={() => setTheme(nextTheme)} data-testid="user-menu-theme">
          <NextThemeIcon size={14} /> {t(`theme.${theme}`)}
        </DropdownMenuItem>
        <DropdownMenuItem className="md:hidden" onSelect={() => setLang(nextLang)} data-testid="user-menu-language">
          <Languages size={14} /> {currentLang === "ja" ? "日本語" : "English"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/settings/account")} data-testid="user-menu-account">
          <Settings size={14} /> {t("userMenu.accountSettings")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/templates")} data-testid="user-menu-templates">
          <FileStack size={14} /> {t("templates.title")}
        </DropdownMenuItem>
        {isAdmin && (
          <DropdownMenuItem onSelect={() => navigate("/admin")} data-testid="user-menu-admin">
            <Shield size={14} /> {t("userMenu.tenantAdmin")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onLogout()} data-testid="user-menu-logout">
          <LogOut size={14} /> {t("nav.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}
