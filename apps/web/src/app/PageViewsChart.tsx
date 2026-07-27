import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

// #464 / ADR-175 (review rework): the daily page-views chart — the interactive replacement for the
// static totals panel. Change-over-time → a multi-series LINE chart (dataviz skill: form first). Three
// categorical series (member / guest / anon), fixed order, colours validated with the skill's palette script
// (light surface #fcfcfb: lightness/chroma/contrast PASS; the member↔… CVD pair sits in the 6–8 floor, made
// legal by the legend's DIRECT LABELS = secondary encoding). Hand-rolled SVG — no chart dependency (ADR-011
// license gate). Presentation only: the `daily` data + authz are unchanged (backend passed device).

// The three series in FIXED order (never cycled). Colours are the `--views-*` tokens (tokens.css), which
// carry their own light + dark steps (dataviz: dark is its own steps, validated on the dark surface, not an
// auto-flip). Label i18n key per series (identity is the coloured mark + its LABEL, never colour alone).
const SERIES = [
  { key: "member" as const, label: "members" },
  { key: "guest" as const, label: "guests" },
  { key: "anon" as const, label: "anon" },
];

export interface DailyPoint { day: string; viewerClass: "member" | "guest" | "anon"; views: number }

const W = 520, H = 180, PAD_L = 34, PAD_R = 12, PAD_T = 12, PAD_B = 30;

// #533: the x axis carried no date labels at all, so a point could not be read back to a day. Pick at most
// `max` evenly spaced indices, ALWAYS including the first and last day — that thins 90 days to roughly
// weekly and 13 months to roughly monthly without a per-range special case, and keeps the labels from
// colliding (the spacing is a function of the label budget, not of the range).
export function axisTicks(count: number, max = 6): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (max - 1);
  const out = new Set<number>();
  for (let i = 0; i < max; i++) out.add(Math.round(i * step));
  return [...out].sort((a, b) => a - b);
}

// Pivot the flat {day, viewerClass, views} rows into an ordered per-day matrix (missing cells = 0), so every
// series is a continuous line over the SAME day axis.
export function pivot(daily: DailyPoint[]) {
  const days = [...new Set(daily.map((d) => d.day))].sort();
  const byDay = new Map<string, Record<string, number>>();
  for (const day of days) byDay.set(day, { member: 0, guest: 0, anon: 0 });
  for (const d of daily) byDay.get(d.day)![d.viewerClass] = d.views;
  return { days, byDay };
}

export function PageViewsChart({ daily, height = H }: { daily: DailyPoint[]; height?: number }) {
  const { t, i18n } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const { days, byDay } = useMemo(() => pivot(daily), [daily]);
  const fmtDay = useMemo(() => new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }), [i18n.language]);
  // Over a long range the day number is noise and the labels crowd; switch to month/year past ~4 months.
  // Same Intl formatter family as everywhere else — no new date-formatting implementation (#533).
  const fmtMonth = useMemo(() => new Intl.DateTimeFormat(i18n.language, { month: "short", year: "2-digit" }), [i18n.language]);

  const max = Math.max(1, ...daily.map((d) => d.views));
  const plotW = W - PAD_L - PAD_R, plotH = height - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (days.length <= 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;

  if (days.length === 0) return <div className="text-xs text-fg-dim" data-testid="page-views-chart-empty">{t("pageAnalytics.noViews")}</div>;

  return (
    <div className="w-full" data-testid="page-views-chart">
      <svg
        viewBox={`0 0 ${W} ${height}`} width="100%" role="img"
        aria-label={t("pageAnalytics.chartAria")}
        onMouseLeave={() => setHover(null)}
        style={{ maxWidth: "100%" }}
      >
        {/* recessive y gridlines + labels at 0 and max */}
        {[0, max].map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} opacity={0.5} />
            <text x={PAD_L - 5} y={y(v) + 3} textAnchor="end" className="fill-fg-dim" fontSize={9}>{v}</text>
          </g>
        ))}
        {/* one hit column per day → hover crosshair + tooltip (dataviz: interactive by default) */}
        {days.map((_, i) => (
          <rect key={i} x={x(i) - plotW / Math.max(1, days.length) / 2} y={PAD_T}
            width={plotW / Math.max(1, days.length)} height={plotH} fill="transparent"
            onMouseEnter={() => setHover(i)} data-testid="page-views-hitcol" />
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + plotH} className="stroke-fg-dim" strokeWidth={1} opacity={0.4} />}
        {/* #533: the x axis — thinned date labels, first and last always shown. `textAnchor` is clamped at
            the edges so the outermost labels stay inside the viewBox instead of being cut off. */}
        {axisTicks(days.length).map((i) => (
          <text key={i} x={x(i)} y={height - 8} fontSize={9} className="fill-fg-dim"
            textAnchor={i === 0 && days.length > 1 ? "start" : i === days.length - 1 && days.length > 1 ? "end" : "middle"}
            data-testid="page-views-xtick">
            {(days.length > 120 ? fmtMonth : fmtDay).format(new Date(days[i]!))}
          </text>
        ))}
        {/* the three series lines (2px) + markers on hover */}
        {SERIES.map((s) => {
          const pts = days.map((day, i) => `${x(i)},${y(byDay.get(day)![s.key])}`).join(" ");
          return (
            <g key={s.key}>
              <polyline points={pts} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
                style={{ stroke: `var(--views-${s.key})` }} />
              {/* #533: an SVG polyline of ONE point draws nothing, so narrowing the range to a single day
                  rendered an empty chart that looked exactly like "no data". A lone day is drawn as a dot
                  — the value is still readable, and it stays distinct from the empty state below. */}
              {days.length === 1 && (
                <circle cx={x(0)} cy={y(byDay.get(days[0]!)![s.key])} r={3.5}
                  style={{ fill: `var(--views-${s.key})` }} stroke="var(--panel)" strokeWidth={1.5}
                  data-testid="page-views-single-dot" />
              )}
              {hover != null && (
                <circle cx={x(hover)} cy={y(byDay.get(days[hover]!)![s.key])} r={3.5}
                  style={{ fill: `var(--views-${s.key})` }} stroke="var(--panel)" strokeWidth={1.5} />
              )}
            </g>
          );
        })}
      </svg>
      {/* tooltip: the hovered day + every series value (identity = the coloured dot + its LABEL, never colour alone) */}
      {hover != null && (
        <div className="mt-1 rounded-md border border-border bg-panel px-2 py-1 text-xs shadow-sm" data-testid="page-views-tooltip">
          <div className="font-medium text-foreground">{fmtDay.format(new Date(days[hover]!))}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-fg-dim">
            {SERIES.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: `var(--views-${s.key})` }} aria-hidden="true" />
                {t(`pageAnalytics.${s.label}`)}: <b className="text-foreground">{byDay.get(days[hover]!)![s.key]}</b>
              </span>
            ))}
          </div>
        </div>
      )}
      {/* legend — always present for ≥2 series, direct-labelled (the CVD-floor secondary encoding) */}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-dim" data-testid="page-views-legend">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm" style={{ background: `var(--views-${s.key})` }} aria-hidden="true" />
            {t(`pageAnalytics.${s.label}`)}
          </span>
        ))}
      </div>
    </div>
  );
}
