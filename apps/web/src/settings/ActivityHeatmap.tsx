import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityDay } from "../data/queries";

// ADR-180 §4: a GitHub-style contribution calendar drawn as a self-contained SVG (no charting library
// — ADR-011). 7 rows (days of the week) × ~53 week columns ending today, over the last ~12 months. The
// colour ramp is a fixed 5-step scale keyed to the day's count, so an empty tenant and a busy one read
// the same way. Colours come from the design tokens; the whole grid is theme-aware via them.

const WEEKS = 53;
const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;

// A local-calendar YYYY-MM-DD (matches the server buckets, which are computed in the browser's own tz).
export function heatmapLocalKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Fixed 5-step ramp: 0 = empty (a faint surface), 1..4 = increasing accent mix. color-mix keeps it
// theme-aware (the accent and surface tokens flip with the theme).
const FILLS = [
  "var(--panel-2)",
  "color-mix(in srgb, var(--accent) 28%, var(--panel-2))",
  "color-mix(in srgb, var(--accent) 52%, var(--panel-2))",
  "color-mix(in srgb, var(--accent) 76%, var(--panel-2))",
  "var(--accent)",
];
export const heatmapLevel = (c: number): number => (c <= 0 ? 0 : c <= 2 ? 1 : c <= 5 ? 2 : c <= 9 ? 3 : 4);

export function ActivityHeatmap({ days }: { days: ActivityDay[] }) {
  const { t } = useTranslation();
  const counts = useMemo(() => new Map(days.map((d) => [d.day, d.count])), [days]);

  const { cells, width, height } = useMemo(() => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    // The leftmost column begins on the Sunday that starts the week (WEEKS-1) weeks before this week.
    const start = new Date(end);
    start.setDate(end.getDate() - ((WEEKS - 1) * 7 + end.getDay()));
    const out: { x: number; y: number; c: number; key: string }[] = [];
    for (let w = 0; w < WEEKS; w++) {
      for (let r = 0; r < 7; r++) {
        const d = new Date(start);
        d.setDate(start.getDate() + w * 7 + r);
        if (d > end) continue; // future days in the current week are omitted
        const key = heatmapLocalKey(d);
        out.push({ x: w * STEP, y: r * STEP, c: counts.get(key) ?? 0, key });
      }
    }
    return { cells: out, width: WEEKS * STEP - GAP, height: 7 * STEP - GAP };
  }, [counts]);

  const total = useMemo(() => days.reduce((s, d) => s + d.count, 0), [days]);

  return (
    <div>
      {/* wide content scrolls inside its own box so the settings column never overflows horizontally */}
      <div className="overflow-x-auto">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t("account.activityAria", { count: total })}
          data-testid="activity-heatmap"
        >
          {cells.map((cell) => (
            <rect
              key={cell.key}
              x={cell.x}
              y={cell.y}
              width={CELL}
              height={CELL}
              rx={2}
              ry={2}
              fill={FILLS[heatmapLevel(cell.c)]}
              data-testid="activity-cell"
              data-count={cell.c}
            >
              <title>{cell.c === 0 ? t("account.activityNone", { date: cell.key }) : t("account.activityCount", { count: cell.c, date: cell.key })}</title>
            </rect>
          ))}
        </svg>
      </div>
      {/* Less → More legend, using the same ramp */}
      <div className="mt-2 flex items-center gap-1 text-[length:var(--text-xs)] text-fg-dim">
        <span>{t("account.activityLess")}</span>
        {FILLS.map((f, i) => (
          <span key={i} className="inline-block rounded-sm" style={{ width: CELL, height: CELL, background: f }} aria-hidden="true" />
        ))}
        <span>{t("account.activityMore")}</span>
      </div>
    </div>
  );
}
