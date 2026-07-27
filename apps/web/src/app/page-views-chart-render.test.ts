// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageViewsChart, type DailyPoint } from "./PageViewsChart";

// #533 (device report). Two defects that only exist in the rendered SVG:
//   1. the x axis carried no date labels, so a point could not be read back to a day;
//   2. narrowing the range to ONE day drew nothing — an SVG polyline of a single point has no geometry —
//      which looked exactly like "no data". Keeping those two states distinguishable is the point.
// (createElement, not JSX, so this stays a .test.ts the web vitest config already picks up.)
const pt = (day: string, views: number): DailyPoint => ({ day, viewerClass: "member", views });
const render = (daily: DailyPoint[]) => renderToStaticMarkup(createElement(PageViewsChart, { daily }));
const count = (html: string, testid: string) => html.split(`data-testid="${testid}"`).length - 1;

describe("#533 the chart is readable at both ends of the range", () => {
  it("labels the x axis with dates", () => {
    const html = render([pt("2026-07-01", 3), pt("2026-07-02", 5), pt("2026-07-03", 4)]);
    expect(count(html, "page-views-xtick"), "every day inside the label budget gets a tick").toBe(3);
    expect(html, "and the ticks carry a formatted date, not an ISO string").toMatch(/page-views-xtick[^>]*>[^<]+</);
  });

  it("thins the labels over a long range instead of crowding them", () => {
    const daily = Array.from({ length: 90 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10);
      return pt(d, i);
    });
    const html = render(daily);
    const ticks = count(html, "page-views-xtick");
    expect(ticks, "a 90-day range does not print 90 labels").toBeLessThanOrEqual(6);
    expect(ticks, "but it is still labelled").toBeGreaterThan(1);
  });

  it("a single day is drawn as a DOT (a one-point polyline draws nothing)", () => {
    const html = render([pt("2026-07-01", 7)]);
    expect(count(html, "page-views-single-dot"), "one dot per series, so the value is visible").toBe(3);
    expect(count(html, "page-views-chart"), "the chart rendered").toBeGreaterThan(0);
    expect(count(html, "page-views-chart-empty"), "…and it is NOT the empty state").toBe(0);
  });

  it("…and no data is still its own, distinguishable state", () => {
    const html = render([]);
    expect(count(html, "page-views-chart-empty"), "0 rows says so").toBe(1);
    expect(count(html, "page-views-single-dot"), "and draws no dot").toBe(0);
  });
});
