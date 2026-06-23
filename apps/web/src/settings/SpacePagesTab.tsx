import { useNavigate, useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSpacePagesOverview } from "../data/queries";

interface SpaceCtx { spaceId: string; name: string; accentKey: string | null }

const chip = "rounded-full border px-2 py-px text-[11px]";

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
    <div className="max-w-[720px] p-6" data-testid="space-pages">
      <h2 className="mt-0">{t("spacePages.title")}</h2>
      {pages.isLoading && <p className="text-sm text-fg-dim">{t("common.loading")}</p>}
      {!pages.isLoading && (pages.data?.length ?? 0) === 0 && <p className="text-sm text-fg-dim">{t("spacePages.empty")}</p>}

      {(pages.data?.length ?? 0) > 0 && (
        <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:p-2 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.03em] [&_th]:text-fg-dim">
          <thead>
            <tr>
              <th>{t("spacePages.title")}</th>
              <th>{t("spacePages.status")}</th>
              <th className="w-[72px] !text-right">{t("spacePages.grants")}</th>
              <th className="w-[72px] !text-right">{t("spacePages.links")}</th>
            </tr>
          </thead>
          <tbody>
            {pages.data!.map((p) => (
              <tr key={p.id} className="cursor-pointer" data-testid="space-page-row" onClick={() => navigate(`/p/${p.id}`)}>
                <td>{p.title || t("common.untitled")}</td>
                <td>
                  {!p.published
                    ? <span className={`${chip} border-border text-fg-dim`}>{t("spacePages.draft")}</span>
                    : p.hasUnpublishedChanges
                      ? <span className={`${chip} border-[color-mix(in_srgb,var(--accent)_50%,var(--border))] text-[var(--accent)]`}>{t("spacePages.unpublished")}</span>
                      : <span className="text-sm text-fg-dim">{t("spacePages.published")}</span>}
                </td>
                <td className="w-[72px] text-right">{p.grantCount}</td>
                <td className="w-[72px] text-right">{p.linkCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
