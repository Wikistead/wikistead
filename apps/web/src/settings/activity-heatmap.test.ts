import { describe, it, expect } from "vitest";
import { heatmapLevel, heatmapLocalKey } from "./ActivityHeatmap";

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
