import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Link as LinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { RightPanel } from "../ui/RightPanel";
import { useBacklinks } from "../data/queries";

// #322 / ADR-133 increment ①: the right-rail "Related" panel — the IA home for a page's link
// neighbourhood. It replaces the single-purpose "Backlinks" panel (#230) with a SECTION layout so the
// later increments slot in without another IA change: §Backlinks (1-hop, here now) → §Related (2-hop,
// increment ②) → §Local graph / §Tags (separate tickets, ADR-133 §6). Each section is server
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

export function RelatedPanel({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useBacklinks(pageId);
  const backlinks = data ?? [];
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
                <li key={b.id}>
                  <button
                    type="button"
                    data-testid={`backlink-${b.id}`}
                    className="w-full cursor-pointer truncate text-left text-[13px] text-[var(--link)] hover:underline"
                    onClick={() => navigate(`/p/${b.id}`)}
                  >
                    {b.title || t("backlinks.untitled")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </RelatedSection>
        {/* Reserved for later increments (ADR-133): §Related (2-hop, increment ②), §Local graph, §Tags.
            Each will be its own view-gated section under this same panel — no further IA change. */}
      </div>
    </RightPanel>
  );
}
