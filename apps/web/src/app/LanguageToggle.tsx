import { Menu } from "@ark-ui/react/menu";
import { Portal } from "@ark-ui/react/portal";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LANGS, setLang, type Lang } from "../i18n";
import styles from "./AppShell.module.css";

// Language switcher (Phase 5). Lives in the app header next to the theme switcher;
// available to every user (members + guests) — Japanese is core to positioning, so
// the path to it must always be one click away. The choice persists (localStorage)
// and is detected from the browser on first visit (see i18n/index.ts).
export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage ?? i18n.language;
  return (
    <Menu.Root onSelect={(d) => setLang(d.value as Lang)}>
      <Menu.Trigger className={styles.iconBtn} aria-label={t("language.label")} title={t("language.label")} data-testid="language-toggle">
        <Languages size={15} />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content className={styles.menu} data-testid="language-menu">
            {LANGS.map((l) => (
              <Menu.Item key={l} value={l} className={styles.menuItem} data-active={current === l ? "" : undefined} data-testid={`language-${l}`}>
                {t(`language.${l}`)}
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
