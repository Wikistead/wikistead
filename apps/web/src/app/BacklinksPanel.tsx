import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Link as LinkIcon } from "lucide-react";
import { RightPanel } from "../ui/RightPanel";
import { useBacklinks } from "../data/queries";

// #230 (review redesign): "Linked mentions" as a right-rail panel opened from the ⋯ menu (was a
// bottom section that never rendered in edit mode). Server FGA-view-gates each result — the panel shows
// exactly what the endpoint returns (no client-side filtering / re-count). Openable in edit mode too.
export function BacklinksPanel({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useBacklinks(pageId);
  const items = data ?? [];
  return (
    <RightPanel
      testId="backlinks-panel"
      title={<span className="inline-flex items-center gap-1"><LinkIcon size={14} /> {t("backlinks.title", { count: items.length })}</span>}
      onClose={onClose}
    >
      {items.length === 0 ? (
        <p className="text-[13px] text-fg-dim" data-testid="backlinks-empty">{t("backlinks.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((b) => (
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
    </RightPanel>
  );
}
