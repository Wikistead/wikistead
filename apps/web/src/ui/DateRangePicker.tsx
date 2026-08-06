import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
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
  const gridRef = useRef<HTMLDivElement>(null);

  const fromT = parseISODate(from);
  const toT = parseISODate(to);
  const year = new Date(cursor).getUTCFullYear();
  const month = new Date(cursor).getUTCMonth();
  const cells = useMemo(() => monthGrid(year, month), [year, month]);

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
    const iso = toISODate(t);
    // First click starts a range; the second closes it. Clicking before the start restarts rather than
    // producing a backwards range the server would answer with nothing.
    if (fromT == null || toT != null || t < fromT) onChange({ from: iso, to: undefined });
    else { onChange({ from, to: iso }); setOpen(false); }
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
        {/* The typed path stays. A calendar is faster for "last week", and a text field is faster for a
            date you already know — removing it would trade one capability for another. */}
        <Input
          inputSize={size}
          type="date"
          value={from ?? ""}
          onChange={(e) => onChange({ from: e.target.value || undefined, to })}
          data-testid={`${testId}-from`}
          aria-label={t("spaceAnalytics.from")}
        />
        <Input
          inputSize={size}
          type="date"
          value={to ?? ""}
          onChange={(e) => onChange({ from, to: e.target.value || undefined })}
          data-testid={`${testId}-to`}
          aria-label={t("spaceAnalytics.to")}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size={size} data-testid={`${testId}-trigger`} aria-label={t("spaceAnalytics.pickRange")}>
              <CalendarDays size={14} aria-hidden />
              <span className="ml-1">{label}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent data-testid={`${testId}-panel`} className="w-[17rem]">
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
            <div ref={gridRef} role="grid" className="grid grid-cols-7 gap-0.5" data-testid={`${testId}-grid`}>
              {cells.map((cellT) => {
                const iso = toISODate(cellT);
                const outside = new Date(cellT).getUTCMonth() !== month;
                const selected = iso === from || iso === to;
                const inRange = fromT != null && toT != null && cellT > fromT && cellT < toT;
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
                    className={[
                      "rounded-sm py-1 text-xs",
                      outside ? "text-fg-dim/50" : "text-foreground",
                      selected ? "bg-[var(--accent)] text-[var(--accent-fg,#fff)]"
                        : inRange ? "bg-[color-mix(in_srgb,var(--accent)_18%,transparent)]"
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
