import { describe, it, expect } from "vitest";
import { pivot, type DailyPoint } from "./PageViewsChart";

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
