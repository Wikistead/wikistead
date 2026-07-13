import { useTranslation } from "react-i18next";
import { usePage, usePublished } from "../data/queries";
import { PageMeta } from "../app/PageMeta";
import { PublishedBodyPreview } from "./PublishedBodyPreview";

// #348: the shared right-hand preview pane for the search / page-embed pickers — title + #222 meta + the
// view-gated PUBLISHED body rendered with the member read-engine (mountPublishedView, via PublishedBodyPreview),
// so a hit looks like the real page, not a source dump. Extracted from SearchModal so the embed picker gets the
// identical pane. authz is unchanged: the body/meta come from the view-gated usePage/usePublished routes for the
// SELECTED page (deny/missing → 404 → empty pane; NEVER Meili stage-1 data), so no new authz surface.
export function HitPreviewPane({ pageId, testid = "hit-preview" }: { pageId: string; testid?: string }) {
  const { t } = useTranslation();
  const pageQ = usePage(pageId);
  const publishedQ = usePublished(pageId);
  return (
    <div className="hidden max-h-[60vh] flex-1 overflow-y-auto p-4 md:block" data-testid={testid}>
      {pageId && pageQ.data ? (
        <>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-sm font-bold">{pageQ.data.title || t("common.untitled")}</div>
            {!pageQ.data.published && <span className="shrink-0 text-xs text-fg-dim" data-testid={`${testid}-draft`}>{t("page.draft")}</span>}
          </div>
          <PageMeta createdBy={pageQ.data.createdBy} updatedBy={pageQ.data.updatedBy} updatedAt={pageQ.data.updatedAt} />
          <div className="mt-3" data-testid={`${testid}-body`}>
            {publishedQ.data?.publishedMd
              ? <PublishedBodyPreview body={publishedQ.data.publishedMd} pageId={pageId} testid={`${testid}-rendered`} />
              : publishedQ.isFetching
                ? <div className="text-xs text-fg-dim">{t("search.searching")}</div>
                : <div className="text-xs text-fg-dim" data-testid={`${testid}-unpublished`}>{t("search.previewUnpublished")}</div>}
          </div>
        </>
      ) : (
        <div className="text-sm text-fg-dim">{pageId && (pageQ.isFetching || publishedQ.isFetching) ? t("search.searching") : ""}</div>
      )}
    </div>
  );
}
