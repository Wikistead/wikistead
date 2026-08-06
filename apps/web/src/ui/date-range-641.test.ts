// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { parseISODate, toISODate, monthGrid } from "./DateRangePicker";

// #641 / ADR-218: the arithmetic under the picker. Every date it handles is a UTC DAY, because that is
// what the server buckets by (`rollup.ts`) — a picker that thought in local time would hand back a
// different day than the one that was clicked.
//
// The timezone check runs east AND west of Greenwich. A single zone cannot show this defect: measured
// from UTC+9 or from UTC alone the numbers agree, and only the western side turns a date into the day
// before. (There is no DST test, deliberately: UTC has no DST, so a passing one would prove nothing.)
const withTZ = (tz: string, fn: () => void) => {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { process.env.TZ = prev; }
};

describe("#641: a day is a UTC day, wherever the reader is", () => {
  for (const tz of ["Asia/Tokyo", "America/Los_Angeles", "UTC"]) {
    it(`round-trips through ${tz} unchanged`, () => {
      withTZ(tz, () => {
        for (const iso of ["2026-01-01", "2026-08-06", "2026-12-31", "2024-02-29"]) {
          expect(toISODate(parseISODate(iso)!), iso).toBe(iso);
        }
      });
    });
  }

  it("refuses a date that does not exist", () => {
    // `Date.UTC(2026, 1, 31)` happily rolls into March; the round trip is what catches it
    expect(parseISODate("2026-02-31")).toBeNull();
    expect(parseISODate("2026-13-01")).toBeNull();
    expect(parseISODate("06/08/2026"), "only the wire format").toBeNull();
    expect(parseISODate(undefined)).toBeNull();
    expect(parseISODate("")).toBeNull();
  });
});

describe("#641: the grid is whole weeks, Sunday first", () => {
  it("starts on a Sunday and ends on a Saturday, whatever the month", () => {
    for (const [y, m] of [[2026, 0], [2026, 7], [2024, 1], [2026, 11]] as const) {
      const cells = monthGrid(y, m);
      expect(cells.length % 7, `${y}-${m + 1} is whole weeks`).toBe(0);
      expect(new Date(cells[0]!).getUTCDay(), `${y}-${m + 1} starts Sunday`).toBe(0);
      expect(new Date(cells[cells.length - 1]!).getUTCDay(), `${y}-${m + 1} ends Saturday`).toBe(6);
    }
  });

  it("contains every day of the month and nothing from two months away", () => {
    const cells = monthGrid(2026, 7); // August 2026
    const inMonth = cells.filter((t) => new Date(t).getUTCMonth() === 7);
    expect(inMonth.length, "all 31 days of August").toBe(31);
    const months = new Set(cells.map((t) => new Date(t).getUTCMonth()));
    expect([...months].sort(), "August plus its immediate neighbours only").toEqual([6, 7, 8]);
  });

  it("handles a leap February", () => {
    const cells = monthGrid(2024, 1);
    expect(cells.filter((t) => new Date(t).getUTCMonth() === 1).length).toBe(29);
  });

  it("is Sunday-first in every timezone, not only where the machine happens to be", () => {
    for (const tz of ["Asia/Tokyo", "America/Los_Angeles"]) {
      withTZ(tz, () => {
        const cells = monthGrid(2026, 7);
        expect(new Date(cells[0]!).getUTCDay(), tz).toBe(0);
      });
    }
  });
});
