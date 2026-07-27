import { describe, it, expect } from "vitest";
import { pivot, axisTicks, type DailyPoint } from "./PageViewsChart";

// #464 / ADR-175: the chart pivots the flat {day, viewerClass, views} analytics rows into an ordered
// per-day matrix so every series is a continuous line over the SAME day axis. These pins gate that
// transform (the SVG geometry + colours are device-visual).

describe("PageViewsChart pivot (#464)", () => {
  it("orders days ascending and fills every series (missing = 0)", () => {
    const daily: DailyPoint[] = [
      { day: "2026-07-03", viewerClass: "member", views: 5 },
      { day: "2026-07-01", viewerClass: "guest", views: 2 },
      { day: "2026-07-01", viewerClass: "member", views: 3 },
      { day: "2026-07-03", viewerClass: "anon", views: 1 },
    ];
    const { days, byDay } = pivot(daily);
    expect(days).toEqual(["2026-07-01", "2026-07-03"]); // sorted, de-duplicated
    expect(byDay.get("2026-07-01")).toEqual({ member: 3, guest: 2, anon: 0 }); // anon absent → 0
    expect(byDay.get("2026-07-03")).toEqual({ member: 5, guest: 0, anon: 1 }); // guest absent → 0
  });

  it("is empty for no data", () => {
    const { days } = pivot([]);
    expect(days).toEqual([]);
  });

  it("keeps the three viewer classes separate (never merged)", () => {
    const daily: DailyPoint[] = [
      { day: "2026-07-05", viewerClass: "member", views: 4 },
      { day: "2026-07-05", viewerClass: "guest", views: 7 },
      { day: "2026-07-05", viewerClass: "anon", views: 9 },
    ];
    expect(pivot(daily).byDay.get("2026-07-05")).toEqual({ member: 4, guest: 7, anon: 9 });
  });
});

// #533 (device report): "the x axis has no dates" and "narrowing to a single day draws nothing".
// The tick thinning is the part with real logic — an SVG polyline of one point drawing nothing is a
// property of SVG, pinned in page-views-chart-render.test.ts.
describe("#533 x-axis tick thinning", () => {
  it("shows every day when they fit in the label budget", () => {
    expect(axisTicks(1)).toEqual([0]);
    expect(axisTicks(6)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("thins a long range but always keeps the first and last day", () => {
    const ninety = axisTicks(90);
    expect(ninety[0], "the range starts at a labelled day").toBe(0);
    expect(ninety[ninety.length - 1], "and ends at one").toBe(89);
    expect(ninety.length, "the label budget is respected").toBeLessThanOrEqual(6);
    // roughly evenly spaced → no two labels crowd together
    const gaps = ninety.slice(1).map((v, i) => v - ninety[i]!);
    expect(Math.max(...gaps) - Math.min(...gaps), "the spacing is even").toBeLessThanOrEqual(1);
  });

  it("thins 13 months of days the same way (no per-range special case)", () => {
    const year = axisTicks(396);
    expect(year.length).toBeLessThanOrEqual(6);
    expect(year[0]).toBe(0);
    expect(year[year.length - 1]).toBe(395);
  });

  it("an empty range asks for no ticks", () => {
    expect(axisTicks(0)).toEqual([]);
  });
});
