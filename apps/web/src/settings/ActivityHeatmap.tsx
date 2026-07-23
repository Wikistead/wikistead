import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityDay } from "../data/queries";

// ADR-180 §4: a GitHub-style contribution calendar drawn as a self-contained SVG (no charting library
// — ADR-011). 7 rows (days of the week) × ~53 week columns ending today, over the last ~12 months. The
// colour ramp is a fixed 5-step scale keyed to the day's count, so an empty tenant and a busy one read
// the same way. Colours come from the design tokens; the whole grid is theme-aware via them.
// #483 month/year labels above the grid + Mon/Wed/Fri gutter labels (the GitHub convention), and
// a floating hover tooltip (date + count + edits/comments breakdown) replacing the native <title>.

const WEEKS = 53;
const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
const TOP = 16; // the month-label band
const LEFT = 30; // the weekday-label gutter

// A local-calendar YYYY-MM-DD (matches the server buckets, which are computed in the browser's own tz).
export function heatmapLocalKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// #483 the month-label band, derived from the SAME grid geometry as the cells (start = the
// Sunday opening column 0), so a label can never drift off its column. A label sits on the first
// column whose top cell (the Sunday) enters a new month; the first label and every January carry the
// year, so a 12-month span that necessarily crosses a year boundary stays readable.
export function heatmapMonthLabels(start: Date, weeks: number): { week: number; month: number; year: number; withYear: boolean }[] {
  const out: { week: number; month: number; year: number; withYear: boolean }[] = [];
  let prevMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const d = new Date(start);
    d.setDate(start.getDate() + w * 7);
    if (d.getMonth() !== prevMonth) {
      // skip a label that would collide with the next one (a month whose first column is also the
      // last column of the previous month gets a 1-week-wide slot — too narrow to print into)
      const isFirst = out.length === 0;
      out.push({ week: w, month: d.getMonth(), year: d.getFullYear(), withYear: isFirst || d.getMonth() === 0 });
      prevMonth = d.getMonth();
    }
  }
  // drop a cramped first label: if the second label is < 3 columns away the first month has too few
  // columns to carry text without overlapping — its year moves onto the second label instead.
  if (out.length >= 2 && out[1]!.week - out[0]!.week < 3) {
    out[1] = { ...out[1]!, withYear: true };
    out.shift();
  }
  return out;
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

interface Cell { x: number; y: number; c: number; edits: number; comments: number; key: string }

export function ActivityHeatmap({ days }: { days: ActivityDay[] }) {
  const { t, i18n } = useTranslation();
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  // The hovered cell drives a plain-DOM floating tooltip (settings page — no CM tooltip layer here).
  const [hover, setHover] = useState<Cell | null>(null);

  const { cells, months, width, height } = useMemo(() => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    // The leftmost column begins on the Sunday that starts the week (WEEKS-1) weeks before this week.
    const start = new Date(end);
    start.setDate(end.getDate() - ((WEEKS - 1) * 7 + end.getDay()));
    const out: Cell[] = [];
    for (let w = 0; w < WEEKS; w++) {
      for (let r = 0; r < 7; r++) {
        const d = new Date(start);
        d.setDate(start.getDate() + w * 7 + r);
        if (d > end) continue; // future days in the current week are omitted
        const key = heatmapLocalKey(d);
        const rec = byDay.get(key);
        out.push({ x: LEFT + w * STEP, y: TOP + r * STEP, c: rec?.count ?? 0, edits: rec?.edits ?? 0, comments: rec?.comments ?? 0, key });
      }
    }
    return {
      cells: out,
      months: heatmapMonthLabels(start, WEEKS),
      width: LEFT + WEEKS * STEP - GAP,
      height: TOP + 7 * STEP - GAP,
    };
  }, [byDay]);

  const total = useMemo(() => days.reduce((s, d) => s + d.count, 0), [days]);
  const monthName = useMemo(() => new Intl.DateTimeFormat(i18n.language, { month: "short" }), [i18n.language]);
  const longDate = useMemo(() => new Intl.DateTimeFormat(i18n.language, { dateStyle: "long" }), [i18n.language]);
  // Parse the cell key back into a LOCAL date for display (new Date("YYYY-MM-DD") would parse as UTC).
  const keyToDate = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y!, m! - 1, d!);
  };
  // Mon/Wed/Fri (rows 1/3/5 — row 0 is Sunday), localized off any fixed week (2026-01-04 is a Sunday).
  const weekdayName = useMemo(() => new Intl.DateTimeFormat(i18n.language, { weekday: "short" }), [i18n.language]);
  const weekdayRows = [1, 3, 5].map((r) => ({ r, label: weekdayName.format(new Date(2026, 0, 4 + r)) }));

  return (
    <div className="relative">
      {/* wide content scrolls inside its own box so the settings column never overflows horizontally */}
      <div className="overflow-x-auto">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t("account.activityAria", { count: total })}
          data-testid="activity-heatmap"
          onMouseLeave={() => setHover(null)}
        >
          {/* #483 ①: month (+year at the start and every January) labels, on the cell columns */}
          {months.map((m) => (
            <text
              key={`${m.year}-${m.month}`}
              x={LEFT + m.week * STEP}
              y={TOP - 5}
              className="fill-fg-dim"
              fontSize={10}
              data-testid="activity-month-label"
              data-week={m.week}
            >
              {m.withYear ? `${monthName.format(new Date(m.year, m.month, 1))} ${m.year}` : monthName.format(new Date(m.year, m.month, 1))}
            </text>
          ))}
          {/* weekday gutter (Mon/Wed/Fri — the GitHub convention) */}
          {weekdayRows.map(({ r, label }) => (
            <text key={r} x={0} y={TOP + r * STEP + CELL - 2} className="fill-fg-dim" fontSize={9} data-testid="activity-weekday-label">
              {label}
            </text>
          ))}
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
              onMouseEnter={() => setHover(cell)}
            />
          ))}
        </svg>
      </div>
      {/* #483 ②: the floating tooltip — date (member tz formatting) + count + edits/comments
          breakdown; an empty day says so in words. Plain DOM, positioned off the hovered cell. */}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-panel px-2 py-1 text-xs shadow-md"
          style={{ left: Math.max(0, hover.x - 60), top: hover.y + STEP + 4 }}
          data-testid="activity-tooltip"
        >
          <div className="font-medium text-foreground">{longDate.format(keyToDate(hover.key))}</div>
          {hover.c === 0 ? (
            <div className="text-fg-dim">{t("account.activityTooltipNone")}</div>
          ) : (
            <div className="text-fg-dim">
              {t("account.activityTooltipTotal", { count: hover.c })}
              {" · "}
              {t("account.activityTooltipEdits", { count: hover.edits })}
              {" · "}
              {t("account.activityTooltipComments", { count: hover.comments })}
            </div>
          )}
        </div>
      )}
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
