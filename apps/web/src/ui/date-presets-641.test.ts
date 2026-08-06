import { describe, it, expect } from "vitest";
import { PRESETS } from "./DateRangePicker";

// #641the presets are arithmetic, and arithmetic on dates goes wrong at the ends.
//
// `now` is injected rather than read from the clock, because a range computed from the real time cannot
// be asserted — only observed, and only until tomorrow. Every case below names the answer.
const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const preset = (key: string) => PRESETS.find((p) => p.key === key)!;

describe("#641: the analytics presets", () => {
  it("counts INCLUSIVE at both ends, because that is what the server reads", () => {
    // seven days ending today is six days back, not seven: `day >= from AND day <= to` counts both.
    expect(preset("7d").range(at("2026-08-06"))).toEqual({ from: "2026-07-31", to: "2026-08-06" });
    expect(preset("30d").range(at("2026-08-06"))).toEqual({ from: "2026-07-08", to: "2026-08-06" });
  });

  it("this month starts at the first, whatever day it is", () => {
    expect(preset("month").range(at("2026-08-06"))).toEqual({ from: "2026-08-01", to: "2026-08-06" });
    // …including on the first itself, where from and to are the same day
    expect(preset("month").range(at("2026-08-01"))).toEqual({ from: "2026-08-01", to: "2026-08-01" });
  });

  it("crosses a month and a year boundary without arriving in the wrong one", () => {
    expect(preset("7d").range(at("2026-03-03"))).toEqual({ from: "2026-02-25", to: "2026-03-03" });
    expect(preset("7d").range(at("2026-01-03"))).toEqual({ from: "2025-12-28", to: "2026-01-03" });
    // a leap February, where a naive "subtract a month" lands on the 31st of a month with 28 days
    expect(preset("30d").range(at("2028-03-05"))).toEqual({ from: "2028-02-05", to: "2028-03-05" });
  });

  it("reads the clock in UTC, so the range matches the day buckets the chart draws", () => {
    // 2026-08-06 22:00 UTC is already the 7th in Tokyo. The window must still end on the 6th, because
    // that is the bucket the server has — a preset that used local dates would ask for a day the chart
    // does not draw. (Measured as an instant, not with a TZ env: what is under test is the arithmetic.)
    expect(preset("7d").range(Date.parse("2026-08-06T22:00:00Z")).to).toBe("2026-08-06");
    expect(preset("7d").range(Date.parse("2026-08-06T00:30:00Z")).to).toBe("2026-08-06");
  });
});
