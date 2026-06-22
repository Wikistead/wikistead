import { Menu } from "@ark-ui/react/menu";
import { Portal } from "@ark-ui/react/portal";
import { useNavigate } from "react-router-dom";
import { Shield, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSession } from "../session/SessionProvider";
import { Avatar } from "../ui/Avatar";
import styles from "./AppShell.module.css";

// Header user menu (member chrome only — rendered when onLogout is provided).
// Hosts the tenant-admin entry (shown only when isAdmin — UI convenience; the
// server re-checks tenant#admin on every admin action) and Sign out.
export function UserMenu({ onLogout }: { onLogout: () => void }) {
  const { t } = useTranslation();
  const { isAdmin, displayName, picture, sub, user } = useSession();
  const navigate = useNavigate();
  const name = displayName ?? sub ?? t("userMenu.label");
  return (
    <Menu.Root
      onSelect={(d) => {
        if (d.value === "admin") navigate("/admin");
        else if (d.value === "logout") onLogout();
      }}
    >
      <Menu.Trigger className={styles.avatarBtn} aria-label={t("userMenu.label")} title={name} data-testid="user-menu">
        <Avatar name={name} src={picture} seed={user.seed ?? sub ?? name} size={26} data-testid="user-avatar" />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content className={styles.menu} data-testid="user-menu-content">
            {isAdmin && (
              <Menu.Item value="admin" className={styles.menuItem} data-testid="user-menu-admin">
                <Shield size={14} /> {t("userMenu.tenantAdmin")}
              </Menu.Item>
            )}
            <Menu.Item value="logout" className={styles.menuItem} data-testid="user-menu-logout">
              <LogOut size={14} /> {t("nav.signOut")}
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
