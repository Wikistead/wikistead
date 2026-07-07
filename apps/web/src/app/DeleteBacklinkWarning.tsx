import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useBacklinks } from "../data/queries";

// #246: a warning shown in the page-delete confirm dialog when the page is referenced by other pages.
// Reuses the #230 backlinks endpoint (server FGA-view-gates each result, so the count is only referrers
// the deleter can see — no permission leak; draft-only references are out of scope, published_md v1).
// Delete is NOT blocked — this is advisory. Referrer titles navigate to the page (which abandons the
// delete via onNavigate closing the dialog). Renders nothing when there are no visible backlinks.
export function DeleteBacklinkWarning({ pageId, onNavigate }: { pageId: string | null; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useBacklinks(pageId, pageId != null);
  if (!data || data.length === 0) return null;
  return (
    <div
      data-testid="delete-backlink-warning"
      className="rounded-md border border-[color-mix(in_srgb,var(--callout-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--callout-warning)_10%,transparent)] px-3 py-2 text-[length:var(--text-ui)]"
    >
      <p className="text-foreground">{t("delete.backlinkWarning", { count: data.length })}</p>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {data.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              data-testid="delete-backlink-item"
              className="cursor-pointer truncate text-left text-[var(--link)] hover:underline"
              onClick={() => { onNavigate?.(); navigate(`/p/${b.id}`); }}
            >
              {b.title || t("backlinks.untitled")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
