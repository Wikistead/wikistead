import { describe, it, expect } from "vitest";
import { heatmapLevel, heatmapLocalKey, heatmapMonthLabels } from "./ActivityHeatmap";

// #483 / ADR-180: the pure bits of the contribution heatmap — the fixed 5-step ramp and the local-day
// keying (which must match the server's tz-bucketed 'YYYY-MM-DD' so counts land on the right cells).
describe("heatmapLevel (fixed 5-step ramp)", () => {
  it("maps counts to the 0..4 ramp with stable thresholds", () => {
    expect(heatmapLevel(0)).toBe(0); // empty
    expect(heatmapLevel(1)).toBe(1);
    expect(heatmapLevel(2)).toBe(1);
    expect(heatmapLevel(3)).toBe(2);
    expect(heatmapLevel(5)).toBe(2);
    expect(heatmapLevel(6)).toBe(3);
    expect(heatmapLevel(9)).toBe(3);
    expect(heatmapLevel(10)).toBe(4);
    expect(heatmapLevel(999)).toBe(4);
  });
  it("never returns an out-of-range index (a negative/garbage count is level 0)", () => {
    expect(heatmapLevel(-1)).toBe(0);
  });
});

describe("heatmapLocalKey (local-calendar YYYY-MM-DD)", () => {
  it("zero-pads month and day and uses LOCAL calendar fields (not UTC ISO)", () => {
    // constructed from local components → the key reflects the local date regardless of tz offset
    const d = new Date(2026, 0, 3, 12, 0, 0); // 2026-01-03 local noon
    expect(heatmapLocalKey(d)).toBe("2026-01-03");
  });
  it("keeps the local day even for a late-evening time (no UTC rollover)", () => {
    const d = new Date(2026, 11, 31, 23, 30, 0); // 2026-12-31 local 23:30
    expect(heatmapLocalKey(d)).toBe("2026-12-31");
  });
});

// #483the month-label band is derived from the SAME start/geometry as the cells, so a label
// can never sit off its column. Pin the derivation: labels land on month-entry columns, the first
// label and every January carry a year, and a cramped 1-column first month is dropped (its year
// moves to the next label).
describe("heatmapMonthLabels", () => {
  it("labels each month at its entry column, with the year on the first label and on January", () => {
    // start = Sunday 2025-08-03 → columns advance by 7 days
    const labels = heatmapMonthLabels(new Date(2025, 7, 3), 53);
    expect(labels[0]).toMatchObject({ week: 0, month: 7, year: 2025, withYear: true }); // Aug 2025 opens the grid
    const jan = labels.find((l) => l.month === 0)!;
    expect(jan.year).toBe(2026);
    expect(jan.withYear, "January carries the year (the span crosses a year boundary)").toBe(true);
    // every month from Aug 2025 → Aug 2026 appears exactly once, in order
    expect(labels.map((l) => l.month)).toEqual([7, 8, 9, 10, 11, 0, 1, 2, 3, 4, 5, 6, 7]);
    // and each label's column really is the first column whose Sunday enters that month
    for (const l of labels) {
      const d = new Date(2025, 7, 3);
      d.setDate(d.getDate() + l.week * 7);
      expect(d.getMonth(), `label at week ${l.week} matches its column's month`).toBe(l.month);
    }
  });

  it("drops a cramped first label (a <3-column first month) and moves its year to the next label", () => {
    // start = Sunday 2025-08-24 → August has only 1 column before September begins
    const labels = heatmapMonthLabels(new Date(2025, 7, 24), 53);
    expect(labels[0]!.month, "the 1-column August label is dropped").toBe(8);
    expect(labels[0]!.withYear, "…and September inherits the year").toBe(true);
  });
});
