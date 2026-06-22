import { useNavigate, useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSpacePagesOverview } from "../data/queries";
import styles from "./AdminSpacesTab.module.css";

interface SpaceCtx { spaceId: string; name: string; accentKey: string | null }

// Space → Pages overview (Phase 5 #5). A manager's-eye view of every page in the
// space: published state, unpublished changes, direct-grant count, active share
// links. space#manage gated server-side (and the whole settings screen is manager-
// only), so it never shows pages outside the manager's authority.
export function SpacePagesTab() {
  const { t } = useTranslation();
  const { spaceId } = useOutletContext<SpaceCtx>();
  const navigate = useNavigate();
  const pages = useSpacePagesOverview(spaceId);

  return (
    <div className={styles.wrap} data-testid="space-pages">
      <h2 style={{ marginTop: 0 }}>{t("spacePages.title")}</h2>
      {pages.isLoading && <p className={styles.dim}>{t("common.loading")}</p>}
      {!pages.isLoading && (pages.data?.length ?? 0) === 0 && <p className={styles.dim}>{t("spacePages.empty")}</p>}

      {(pages.data?.length ?? 0) > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t("spacePages.title")}</th>
              <th>{t("spacePages.status")}</th>
              <th className={styles.num}>{t("spacePages.grants")}</th>
              <th className={styles.num}>{t("spacePages.links")}</th>
            </tr>
          </thead>
          <tbody>
            {pages.data!.map((p) => (
              <tr key={p.id} data-testid="space-page-row" style={{ cursor: "pointer" }} onClick={() => navigate(`/p/${p.id}`)}>
                <td>{p.title || t("common.untitled")}</td>
                <td>
                  {!p.published
                    ? <span className={styles.draft}>{t("spacePages.draft")}</span>
                    : p.hasUnpublishedChanges
                      ? <span className={styles.dirty}>{t("spacePages.unpublished")}</span>
                      : <span className={styles.dim}>{t("spacePages.published")}</span>}
                </td>
                <td className={styles.num}>{p.grantCount}</td>
                <td className={styles.num}>{p.linkCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
