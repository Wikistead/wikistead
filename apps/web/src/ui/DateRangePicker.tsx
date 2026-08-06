import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, CalendarDays, ArrowRight } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "../components/ui/popover";
import { Input } from "./Input";
import { Button } from "../components/ui/button";

// #641 / ADR-218: the date range for analytics, drawn by this product instead of by the browser.
//
// The complaint was that the calendar looked like plain HTML, because it was: `<input type="date">`
// hands the popup to the browser, which paints it in its own colours and its own shapes. This draws the
// grid, so it wears the app's tokens in both themes — and it keeps a text field beside it, because the
// ruling was "make it rich", not "take away the keyboard".
//
// EVERY date here is UTC. The server buckets analytics by UTC day (`rollup.ts`), so a picker that
// thought in local time would hand back a different day than the one the reader clicked, west of
// Greenwich by one and east of it by none. `Date.UTC` and the `getUTC*` accessors are the whole of the
// discipline; there is no DST in it, which is why there is no DST test.
const DAY = 86_400_000;

/** `2026-08-06` → a UTC instant. Returns null for anything that is not exactly that shape. */
export function parseISODate(s: string | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? "").trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // reject 2026-02-31 and friends: the round trip only survives a real date
  return toISODate(t) === `${m[1]}-${m[2]}-${m[3]}` ? t : null;
}

/** A UTC instant → `2026-08-06`. The only formatting on the wire. */
export function toISODate(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * #641the windows a reader actually asks for.
 *
 * Exported and pure so they can be checked without a browser: a preset is arithmetic, and the way it goes
 * wrong is off-by-one at the ends. `now` is a parameter for the same reason — a range that reads the
 * clock cannot be asserted, only observed.
 *
 * UTC throughout, like the rest of this file: the server's day buckets are UTC, and a preset that
 * computed "today" locally would ask for a different day than the one the chart draws.
 */
export const PRESETS: { key: string; range: (now?: number) => { from: string; to: string } }[] = [
  { key: "7d", range: (now = Date.now()) => lastDays(now, 6) },
  { key: "30d", range: (now = Date.now()) => lastDays(now, 29) },
  {
    key: "month",
    range: (now = Date.now()) => {
      const d = new Date(now);
      return { from: toISODate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), to: toISODate(now) };
    },
  },
];

/** A window of `back + 1` days ending today — inclusive at both ends, which is what the server reads.
 *
 *  NOT named `window`: a module-scope function by that name shadows the global for the whole module, and
 *  anything in here that touches `window.*` then reads a function instead. Measured — the app stopped
 *  rendering entirely and eight unrelated specs went red with it. */
function lastDays(now: number, back: number): { from: string; to: string } {
  const end = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return { from: toISODate(end - back * DAY), to: toISODate(end) };
}

/**
 * The days of one month's grid, Sunday first, padded to whole weeks.
 *
 * Sunday because `ActivityHeatmap` already draws Sunday-first on this very screen, and two calendars
 * disagreeing about where a week starts is worse than either convention. (The locale's own answer lives
 * on `Intl.Locale#getWeekInfo` — not on `DateTimeFormat`, which is where a first draft looked — and for
 * ja and en it is Sunday anyway.)
 */
export function monthGrid(year: number, month: number): number[] {
  const first = Date.UTC(year, month, 1);
  const start = first - new Date(first).getUTCDay() * DAY;
  const end = Date.UTC(year, month + 1, 0);
  const cells: number[] = [];
  for (let t = start; t <= end || cells.length % 7 !== 0; t += DAY) cells.push(t);
  return cells;
}

/**
 * #649: what one click on a day does, given what is already chosen.
 *
 * Pure and exported because the interesting part is not the pixels: it is that a range leaving here is
 * never backwards. A reader who picks the 20th and then the 14th has expressed the same fortnight as one
 * who picks them the other way round, and the shorter route is to say so — the earlier version restarted
 * the selection instead, which reads as the calendar refusing an answer it understood.
 *
 * The order is fixed HERE rather than at the caller, because a backwards range is not a display quirk:
 * the server answers `from > to` with an empty result, so a picker that let one out would produce a chart
 * of nothing with no way to tell why. Swapping is allowed inside the interaction; nothing backwards
 * leaves it.
 */
export function nextRange(
  current: { from?: string; to?: string },
  clickedT: number,
): { from?: string; to?: string } {
  const fromT = parseISODate(current.from);
  const toT = parseISODate(current.to);
  const iso = toISODate(clickedT);
  // no start yet, or a complete range being replaced → this click starts a new one
  if (fromT == null || toT != null) return { from: iso, to: undefined };
  const [lo, hi] = clickedT < fromT ? [clickedT, fromT] : [fromT, clickedT];
  return { from: toISODate(lo), to: toISODate(hi) };
}

/** The span a tentative second endpoint would produce — the faint band drawn while choosing. */
export function tentativeSpan(
  fromT: number | null,
  toT: number | null,
  previewT: number | null,
): { lo: number; hi: number } | null {
  if (fromT == null || toT != null || previewT == null) return null;
  return previewT < fromT ? { lo: previewT, hi: fromT } : { lo: fromT, hi: previewT };
}

export interface DateRangePickerProps {
  from?: string;
  to?: string;
  onChange: (range: { from?: string; to?: string }) => void;
  testId?: string;
}

export function DateRangePicker({ from, to, onChange, testId = "date-range" }: DateRangePickerProps) {
  const { t, i18n } = useTranslation();
  // #535: this stands in a row of `sm` controls, so it says so rather than inheriting a default that
  // would leave the row half a step taller than it was.
  const size = "sm" as const;
  const [open, setOpen] = useState(false);
  // which month the grid is showing — the range's start, or today when there is none
  const [cursor, setCursor] = useState(() => parseISODate(from) ?? Date.now());
  // #649: the day the reader is CONSIDERING — pointed at or focused. One piece of state for both,
  // because a preview only the mouse can see is a preview keyboard readers do not have, and this grid
  // was built for the keyboard (#587/#588).
  const [previewT, setPreviewT] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const fromT = parseISODate(from);
  const toT = parseISODate(to);
  const year = new Date(cursor).getUTCFullYear();
  const month = new Date(cursor).getUTCMonth();
  const cells = useMemo(() => monthGrid(year, month), [year, month]);
  const tentative = tentativeSpan(fromT, toT, previewT);

  // Month and weekday names come from the browser for whatever language the app is in — no table of
  // names here, so a language added tomorrow reads correctly without this file changing.
  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { year: "numeric", month: "long", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, month, 1))),
    [i18n.language, year, month],
  );
  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language, { weekday: "short", timeZone: "UTC" });
    return monthGrid(2026, 0).slice(0, 7).map((t) => fmt.format(new Date(t)));
  }, [i18n.language]);

  const pick = (t: number) => {
    const next = nextRange({ from, to }, t);
    onChange(next);
    // the panel closes when a range is complete — a start on its own is still a question
    if (next.to != null) { setPreviewT(null); setOpen(false); }
  };

  // Arrow keys move by a day and a week; the grid is one tab stop and the focused cell carries it
  // (#587/#588: a keyboard reaches every day without tabbing through forty-two of them).
  const onGridKey = (e: React.KeyboardEvent<HTMLElement>, t: number) => {
    const step = { ArrowLeft: -DAY, ArrowRight: DAY, ArrowUp: -7 * DAY, ArrowDown: 7 * DAY }[e.key];
    if (step) {
      e.preventDefault();
      const next = t + step;
      if (new Date(next).getUTCMonth() !== month) setCursor(next);
      requestAnimationFrame(() => {
        gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${toISODate(next)}"]`)?.focus();
      });
      return;
    }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(t); }
  };

  const label = from || to ? `${from ?? "…"} → ${to ?? "…"}` : t("spaceAnalytics.pickRange");

  return (
    <div className="flex flex-col gap-1 text-xs text-fg-dim">
      {t("spaceAnalytics.period")}
      <div className="flex items-center gap-2">
        {/* #641/ONE entrance on the row.
            The two fields were `type="date"`, so the row carried three ways into a calendar and two of
            them opened Chrome's own — square corners, white frame, the thing the reject called .
            Hiding `::-webkit-calendar-picker-indicator` would not have done it: F4 and Alt+Down still
            open it, and the browser keeps formatting the value. The `type` itself had to change.
            The typed path is not lost, only moved: the fields live inside the panel now (below), so
            "keyboard-only must still work" holds and the row has one control. */}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size={size} data-testid={`${testId}-trigger`} aria-label={t("spaceAnalytics.pickRange")}>
              <CalendarDays size={14} aria-hidden />
              <span className="ml-1">{label}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent data-testid={`${testId}-panel`} className="w-[17rem]">
            {/* the typed path, where the calendar is. `type="text"` rather than `date`: this is what
                keeps the browser's own picker out of the product. `YYYY-MM-DD` is what the server takes
                and what the grid writes, so the two halves of this panel speak one language. */}
            <div className="mb-2 flex items-center gap-1.5">
              <Input
                inputSize="sm"
                type="text"
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                value={from ?? ""}
                onChange={(e) => onChange({ from: e.target.value || undefined, to })}
                data-testid={`${testId}-from`}
                aria-label={t("spaceAnalytics.from")}
              />
              <ArrowRight size={12} className="flex-none text-fg-dim" aria-hidden />
              <Input
                inputSize="sm"
                type="text"
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                value={to ?? ""}
                onChange={(e) => onChange({ from, to: e.target.value || undefined })}
                data-testid={`${testId}-to`}
                aria-label={t("spaceAnalytics.to")}
              />
            </div>
            {/* #641the presets are what a reader reaches for most — a window ending today, which
                otherwise costs two clicks in two different months. Computed in UTC like everything else
                here, because the server's day buckets are UTC. */}
            <div className="mb-2 flex flex-wrap gap-1" data-testid={`${testId}-presets`}>
              {PRESETS.map((p) => (
                <Button
                  key={p.key}
                  variant="ghost"
                  size="sm"
                  data-testid={`${testId}-preset-${p.key}`}
                  onClick={() => { onChange(p.range()); setOpen(false); }}
                >{t(`spaceAnalytics.preset_${p.key}`)}</Button>
              ))}
            </div>
            <div className="mb-2 flex items-center justify-between">
              <Button variant="ghost" size="sm" aria-label={t("spaceAnalytics.prevMonth")}
                data-testid={`${testId}-prev`}
                onClick={() => setCursor(Date.UTC(year, month - 1, 1))}><ChevronLeft size={14} /></Button>
              <span className="text-sm font-medium text-foreground" data-testid={`${testId}-month`}>{monthLabel}</span>
              <Button variant="ghost" size="sm" aria-label={t("spaceAnalytics.nextMonth")}
                data-testid={`${testId}-next`}
                onClick={() => setCursor(Date.UTC(year, month + 1, 1))}><ChevronRight size={14} /></Button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] text-fg-dim" aria-hidden>
              {weekdays.map((w) => <span key={w}>{w}</span>)}
            </div>
            <div ref={gridRef} role="grid" className="grid grid-cols-7 gap-0.5" data-testid={`${testId}-grid`}
              onMouseLeave={() => setPreviewT(null)}>
              {cells.map((cellT) => {
                const iso = toISODate(cellT);
                const outside = new Date(cellT).getUTCMonth() !== month;
                const selected = iso === from || iso === to;
                const inRange = fromT != null && toT != null && cellT > fromT && cellT < toT;
                // the band drawn while a second endpoint is being considered. Inclusive at both ends so
                // the day under the pointer is part of what it is promising; `selected` still wins the
                // class chain, so the committed start keeps its solid fill.
                const inTentative = tentative != null && cellT >= tentative.lo && cellT <= tentative.hi;
                return (
                  <button
                    key={iso}
                    type="button"
                    role="gridcell"
                    data-day={iso}
                    data-selected={selected ? "true" : undefined}
                    aria-selected={selected}
                    // one tab stop for the grid: the selected day, or the first of the month
                    tabIndex={selected || (!from && !to && new Date(cellT).getUTCDate() === 1 && !outside) ? 0 : -1}
                    onKeyDown={(e) => onGridKey(e, cellT)}
                    onClick={() => pick(cellT)}
                    onMouseEnter={() => setPreviewT(cellT)}
                    onFocus={() => setPreviewT(cellT)}
                    data-tentative={inTentative && !selected ? "true" : undefined}
                    className={[
                      "rounded-sm py-1 text-xs",
                      outside ? "text-fg-dim/50" : "text-foreground",
                      selected ? "bg-[var(--accent)] text-[var(--accent-fg,#fff)]"
                        : inRange || inTentative ? "bg-[color-mix(in_srgb,var(--accent)_18%,transparent)]"
                        : "hover:bg-panel-2",
                    ].join(" ")}
                  >{new Date(cellT).getUTCDate()}</button>
                );
              })}
            </div>
            <div className="mt-2 flex justify-end">
              <Button variant="ghost" size="sm" data-testid={`${testId}-clear`}
                onClick={() => { onChange({ from: undefined, to: undefined }); setOpen(false); }}>
                {t("spaceAnalytics.clearRange")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
