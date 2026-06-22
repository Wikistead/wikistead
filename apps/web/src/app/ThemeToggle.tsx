import { Menu } from "@ark-ui/react/menu";
import { Portal } from "@ark-ui/react/portal";
import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type Theme } from "./ThemeProvider";
import styles from "./AppShell.module.css";

const ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

// Personal theme switcher (Phase 3a). Lives in the app header; available to every
// user (members + guests). The choice is per-user (localStorage) — distinct from
// tenant/space branding (3c), which overrides accent tokens for everyone.
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = ICON[theme];
  return (
    <Menu.Root onSelect={(d) => setTheme(d.value as Theme)}>
      <Menu.Trigger className={styles.iconBtn} aria-label="Theme" title="Theme" data-testid="theme-toggle">
        <Icon size={15} />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content className={styles.menu} data-testid="theme-menu">
            {OPTIONS.map((o) => {
              const OptIcon = ICON[o.value];
              return (
                <Menu.Item key={o.value} value={o.value} className={styles.menuItem} data-active={theme === o.value ? "" : undefined}>
                  <OptIcon size={14} /> {o.label}
                </Menu.Item>
              );
            })}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
