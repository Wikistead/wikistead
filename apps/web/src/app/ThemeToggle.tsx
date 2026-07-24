import { Sun, Moon, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTheme, type Theme } from "./ThemeProvider";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu";

const ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const ORDER: Theme[] = ["light", "dark", "system"];

// Personal theme switcher (Phase 3a). Lives in the app header; available to every
// user (members + guests). The choice is per-user (localStorage) — distinct from
// tenant/space branding (3c), which overrides accent tokens for everyone.
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();
  const Icon = ICON[theme];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger className="ml-2 flex cursor-pointer rounded p-1 text-fg-dim transition-colors hover:bg-panel-2 hover:text-foreground" aria-label={t("theme.label")} data-tip={t("theme.label")} data-testid="theme-toggle">
        <Icon size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="theme-menu">
        {ORDER.map((value) => {
          const OptIcon = ICON[value];
          return (
            <DropdownMenuItem key={value} onSelect={() => setTheme(value)} data-active={theme === value ? "" : undefined} className={theme === value ? "font-semibold" : undefined}>
              <OptIcon size={14} /> {t(`theme.${value}`)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
