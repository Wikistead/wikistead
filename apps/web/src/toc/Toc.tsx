import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "../lib/utils";
import type { Heading } from "../editor/headings";

// #192 / ADR-091: the table-of-contents rail. Derived, display-only (headings come from the editor;
// clicking jumps via the host-provided onJump; the active item follows scroll). Depth-filtered
// (default H3), indented by relative level, with the current section highlighted (scroll-spy).
const DEPTHS = [1, 3, 6] as const; // H1 only / H1–H3 / all — the depth presets

export function Toc({
  headings, activeFrom, depth, onJump, onSetDepth, onClose,
}: {
  headings: Heading[];
  activeFrom: number | null;
  depth: number;
  onJump: (from: number) => void;
  onSetDepth: (d: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const shown = headings.filter((h) => h.level <= depth);
  const minLevel = shown.length ? Math.min(...shown.map((h) => h.level)) : 1;
  return (
    <nav
      className="wks-slide-right flex min-h-0 w-[240px] flex-none flex-col overflow-y-auto border-l border-border bg-panel p-3 text-[length:var(--text-ui)]"
      aria-label={t("toc.title")}
      data-testid="toc"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[length:var(--text-xs)] uppercase tracking-wide text-fg-dim">{t("toc.title")}</span>
        <div className="flex items-center gap-1">
          {DEPTHS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onSetDepth(d)}
              aria-pressed={depth === d}
              data-testid={`toc-depth-${d}`}
              className={cn("cursor-pointer rounded px-1.5 py-0.5 text-[length:var(--text-xs)] text-fg-dim hover:bg-panel-2", depth === d && "bg-panel-2 font-medium text-foreground")}
              title={t("toc.depthTitle", { n: d })}
            >{`H${d}`}</button>
          ))}
          <button type="button" onClick={onClose} data-testid="toc-close" aria-label={t("common.close")} className="ml-1 inline-flex cursor-pointer items-center rounded p-1 text-fg-dim hover:bg-panel-2 hover:text-foreground"><X size={14} /></button>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="m-0 text-[length:var(--text-sm)] text-fg-dim">{t("toc.empty")}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {shown.map((h) => (
            <li key={h.slug}>
              <button
                type="button"
                onClick={() => onJump(h.from)}
                data-testid="toc-item"
                data-active={activeFrom === h.from ? "" : undefined}
                style={{ paddingLeft: `${8 + (h.level - minLevel) * 12}px` }}
                className={cn(
                  "block w-full cursor-pointer truncate rounded py-1 pr-2 text-left text-fg-dim transition-colors duration-[120ms] hover:bg-panel-2 hover:text-foreground",
                  activeFrom === h.from && "bg-panel-2 font-medium text-foreground",
                )}
                title={h.text}
              >{h.text || t("common.untitled")}</button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
