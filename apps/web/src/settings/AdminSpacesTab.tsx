import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAdminSpaces } from "../data/queries";
import { Button } from "../ui/Button";
import styles from "./AdminSpacesTab.module.css";

// Tenant admin → Spaces overview (Phase 5 #4). Lists every space in the tenant
// with page + direct-grant counts, and links to each space's settings. tenant#admin
// gated server-side (the AdminLayout already gates the whole console on isAdmin).
export function AdminSpacesTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const spaces = useAdminSpaces();

  return (
    <div className={styles.wrap} data-testid="admin-spaces">
      <h2 style={{ marginTop: 0 }}>{t("adminSpaces.title")}</h2>
      {spaces.isLoading && <p className={styles.dim}>{t("common.loading")}</p>}
      {!spaces.isLoading && (spaces.data?.length ?? 0) === 0 && <p className={styles.dim}>{t("adminSpaces.empty")}</p>}

      {(spaces.data?.length ?? 0) > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t("adminSpaces.name")}</th>
              <th className={styles.num}>{t("adminSpaces.pages")}</th>
              <th className={styles.num}>{t("adminSpaces.sharedWith")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {spaces.data!.map((s) => (
              <tr key={s.id} data-testid="admin-space-row">
                <td>{s.name || t("sidebar.untitledSpace")}</td>
                <td className={styles.num}>{s.pageCount}</td>
                <td className={styles.num}>{s.grantCount}</td>
                <td className={styles.actions}>
                  <Button size="sm" variant="ghost" data-testid="admin-space-settings" onClick={() => navigate(`/spaces/${s.id}/settings`)}>{t("adminSpaces.manage")}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
