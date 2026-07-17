import { useNavigate, useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSpacePagesOverview } from "../data/queries";

interface SpaceCtx { spaceId: string; name: string; accentKey: string | null }

// whitespace-nowrap: a squeezed status column must never wrap the badge text vertically (#439).
const chip = "whitespace-nowrap rounded-full border px-2 py-px text-[11px]";

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
    // #439: widened (was 720px) + table-fixed below — the auto layout let long titles squeeze the
    // status column until its badges wrapped one glyph per line.
    <div className="max-w-[920px] p-6" data-testid="space-pages">
      <h2 className="mt-0">{t("spacePages.title")}</h2>
      {pages.isLoading && <p className="text-sm text-fg-dim">{t("common.loading")}</p>}
      {!pages.isLoading && (pages.data?.length ?? 0) === 0 && <p className="text-sm text-fg-dim">{t("spacePages.empty")}</p>}

      {(pages.data?.length ?? 0) > 0 && (
        <table className="w-full table-fixed border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:p-2 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.03em] [&_th]:text-fg-dim">
          <thead>
            <tr>
              {/* table-fixed: the title column takes the REMAINING width (and truncates); the
                  status/count columns are fixed and never wrap (#439). */}
              <th className="whitespace-nowrap">{t("spacePages.title")}</th>
              <th className="w-[132px] whitespace-nowrap">{t("spacePages.status")}</th>
              <th className="w-[88px] whitespace-nowrap !text-right">{t("spacePages.grants")}</th>
              <th className="w-[88px] whitespace-nowrap !text-right">{t("spacePages.links")}</th>
            </tr>
          </thead>
          <tbody>
            {pages.data!.map((p) => (
              <tr key={p.id} className="cursor-pointer" data-testid="space-page-row" onClick={() => navigate(`/p/${p.id}`)}>
                <td><div className="truncate" title={p.title || undefined}>{p.title || t("common.untitled")}</div></td>
                <td className="whitespace-nowrap">
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
