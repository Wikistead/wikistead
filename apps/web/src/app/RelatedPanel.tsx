import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Link as LinkIcon, Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import { RightPanel } from "../ui/RightPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { useBacklinks, useLocalGraph, useRelated } from "../data/queries";
import { LocalGraphCanvas } from "./LocalGraph";

// #322 / ADR-133 increment ①: the right-rail "Related" panel — the IA home for a page's link
// neighbourhood. It replaces the single-purpose "Backlinks" panel (#230) with a SECTION layout so the
// later increments slot in without another IA change: §Backlinks (1-hop, here now) → §Related (2-hop,
// increment ②) → §Local graph (#394, increment ③a) → §Tags (separate ticket). Each section is server
// FGA-view-gated at its own endpoint (the panel never client-filters / re-counts). Openable in edit mode.
function RelatedSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1" data-testid="related-section">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-fg-dim">
        {title}
        <span className="ml-1 tabular-nums opacity-70">{count}</span>
      </h3>
      {children}
    </section>
  );
}

// #394 / ADR-147: the depth-2 graph in a modal (search-modal sizing). Fetched only while open; a node
// click closes the modal and navigates. Over-cap is reported ("top N"), never silently truncated.
function LocalGraphModal({ pageId, open, onClose }: { pageId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useLocalGraph(pageId, 2, open);
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-5xl" data-testid="local-graph-modal">
        <DialogHeader>
          <DialogTitle>{t("related.graph")}</DialogTitle>
        </DialogHeader>
        {data && (
          <LocalGraphCanvas
            data={data}
            onOpenPage={(id) => { onClose(); navigate(`/p/${id}`); }}
            className="h-[65vh] w-full overflow-hidden rounded-md border border-border"
          />
        )}
        {data && data.hiddenCount > 0 && (
          <p className="text-[12px] text-fg-dim" data-testid="local-graph-topn">
            {t("related.graphTopN", { count: data.nodes.length })}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RelatedPanel({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useBacklinks(pageId);
  const backlinks = data ?? [];
  // #322 / ADR-133 §2: 2-hop related pages (grouped by the shared link). The panel is only mounted when open,
  // so the query is effectively lazy (fetched when Related opens); the server view-filters both edge ends.
  const related = useRelated(pageId);
  const relatedGroups = related.data?.groups ?? [];
  const relatedCount = relatedGroups.reduce((n, g) => n + g.pages.length, 0);
  // #394 / ADR-147: §Local graph — COLLAPSED by default (sidebar vertical space), lazy (no fetch, no canvas
  // until opened). The mini square is the 1-hop neighbourhood; the modal expands to depth 2.
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphModal, setGraphModal] = useState(false);
  const miniGraph = useLocalGraph(pageId, 1, graphOpen);
  const linkBtn = (id: string, title: string, testid: string) => (
    <button
      type="button"
      data-testid={testid}
      className="w-full cursor-pointer truncate text-left text-[13px] text-[var(--link)] hover:underline"
      onClick={() => navigate(`/p/${id}`)}
    >
      {title || t("backlinks.untitled")}
    </button>
  );
  return (
    <RightPanel
      testId="related-panel"
      title={<span className="inline-flex items-center gap-1"><LinkIcon size={14} /> {t("related.title")}</span>}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {/* §Backlinks — 1-hop pages that link here (moved from the standalone panel). */}
        <RelatedSection title={t("related.backlinks")} count={backlinks.length}>
          {backlinks.length === 0 ? (
            <p className="text-[13px] text-fg-dim" data-testid="backlinks-empty">{t("backlinks.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {backlinks.map((b) => (
                <li key={b.id}>{linkBtn(b.id, b.title, `backlink-${b.id}`)}</li>
              ))}
            </ul>
          )}
        </RelatedSection>
        {/* §Related — 2-hop pages that share a link with this one, grouped by the shared link (Scrapbox-style).
            Both edge ends are view-filtered server-side (#322 / ADR-133 §3). */}
        <RelatedSection title={t("related.related")} count={relatedCount}>
          {relatedGroups.length === 0 ? (
            <p className="text-[13px] text-fg-dim" data-testid="related-empty">{t("related.empty")}</p>
          ) : (
            <div className="flex flex-col gap-3" data-testid="related-groups">
              {relatedGroups.map((g) => (
                <div key={g.intermediate.id} className="flex flex-col gap-0.5">
                  {/* the shared link (intermediate) heads its group; clicking it navigates to that page. */}
                  <button
                    type="button"
                    data-testid={`related-via-${g.intermediate.id}`}
                    className="truncate text-left text-[11px] text-fg-dim hover:text-[var(--link)] hover:underline"
                    onClick={() => navigate(`/p/${g.intermediate.id}`)}
                  >
                    {t("related.via")} {g.intermediate.title || t("backlinks.untitled")}
                  </button>
                  <ul className="flex flex-col gap-0.5 pl-2">
                    {g.pages.map((p) => (
                      <li key={p.id}>{linkBtn(p.id, p.title, `related-${p.id}`)}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </RelatedSection>
        {/* §Local graph (#394 / ADR-147) — collapsed by default; the square mini canvas draws the 1-hop
            neighbourhood (server view-filtered both ends), the expand button opens the depth-2 modal. */}
        <section className="flex flex-col gap-1" data-testid="related-section">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              data-testid="local-graph-toggle"
              className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-fg-dim hover:text-foreground"
              onClick={() => setGraphOpen((v) => !v)}
              aria-expanded={graphOpen}
            >
              <ChevronRight size={12} className={`transition-transform ${graphOpen ? "rotate-90" : ""}`} aria-hidden />
              {t("related.graph")}
            </button>
            {graphOpen && (
              <button
                type="button"
                data-testid="local-graph-expand"
                className="inline-flex cursor-pointer items-center rounded-md p-1 text-fg-dim hover:bg-panel-2 hover:text-foreground"
                aria-label={t("related.graphExpand")}
                onClick={() => setGraphModal(true)}
              >
                <Maximize2 size={13} aria-hidden />
              </button>
            )}
          </div>
          {graphOpen && (
            miniGraph.data && miniGraph.data.nodes.length > 1 ? (
              <div className="flex flex-col gap-1">
                <LocalGraphCanvas
                  data={miniGraph.data}
                  onOpenPage={(id) => navigate(`/p/${id}`)}
                  className="aspect-square w-full overflow-hidden rounded-md border border-border"
                />
                {miniGraph.data.hiddenCount > 0 && (
                  <button
                    type="button"
                    data-testid="local-graph-more"
                    className="cursor-pointer text-left text-[12px] text-[var(--link)] hover:underline"
                    onClick={() => setGraphModal(true)}
                  >
                    {t("related.graphMore", { count: miniGraph.data.hiddenCount })}
                  </button>
                )}
              </div>
            ) : (
              <p className="text-[13px] text-fg-dim" data-testid="local-graph-empty">{t("related.graphEmpty")}</p>
            )
          )}
        </section>
      </div>
      <LocalGraphModal pageId={pageId} open={graphModal} onClose={() => setGraphModal(false)} />
    </RightPanel>
  );
}
