import { useTranslation } from "react-i18next";
import { Link as LinkIcon } from "lucide-react";
import { Link as RouterLink } from "react-router-dom";
import { useBacklinks } from "../data/queries";

// #230: "Linked mentions" — the pages that reference THIS page (persisted /p/<id> links and
// :::embed-page bodies; #224 title-match auto-links are display-only and out of scope). The server
// FGA-view-gates every result, so this never lists a page the viewer can't see. Renders nothing when
// there are none (no empty-state clutter). Member surface (guests use the share route).
export function BacklinksSection({ pageId }: { pageId: string }) {
  const { t } = useTranslation();
  const { data } = useBacklinks(pageId);
  if (!data || data.length === 0) return null;
  return (
    <section data-testid="backlinks" className="mx-auto mt-8 max-w-[46rem] border-t border-border px-4 pt-4 pb-10">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-dim">
        <LinkIcon size={13} /> {t("backlinks.title", { count: data.length })}
      </h2>
      <ul className="flex flex-col gap-1">
        {data.map((b) => (
          <li key={b.id}>
            <RouterLink data-testid={`backlink-${b.id}`} className="text-[14px] text-[var(--accent-ink,#0a5546)] hover:underline" to={`/p/${b.id}`}>
              {b.title || t("backlinks.untitled")}
            </RouterLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
