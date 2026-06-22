import { Menu } from "@ark-ui/react/menu";
import { Portal } from "@ark-ui/react/portal";
import { Sun, Moon, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTheme, type Theme } from "./ThemeProvider";
import styles from "./AppShell.module.css";

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
    <Menu.Root onSelect={(d) => setTheme(d.value as Theme)}>
      <Menu.Trigger className={styles.iconBtn} aria-label={t("theme.label")} title={t("theme.label")} data-testid="theme-toggle">
        <Icon size={15} />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content className={styles.menu} data-testid="theme-menu">
            {ORDER.map((value) => {
              const OptIcon = ICON[value];
              return (
                <Menu.Item key={value} value={value} className={styles.menuItem} data-active={theme === value ? "" : undefined}>
                  <OptIcon size={14} /> {t(`theme.${value}`)}
                </Menu.Item>
              );
            })}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
