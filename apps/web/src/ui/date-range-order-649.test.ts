// #649: picking the second day BEFORE the first one.
//
// The calendar used to restart the selection when the second click landed earlier than the first — the
// reader had expressed a range and the grid answered by forgetting half of it. It did that for a real
// reason: `from > to` makes the server return nothing, so letting a backwards range out would draw an
// empty chart with no explanation. The fix is not to drop the guard but to satisfy it differently:
// swap inside the interaction, and let nothing backwards leave.
//
// Asserted on the pure function rather than through a rendered grid, because what matters here is not
// which pixels move: it is the invariant that every range this control emits has from <= to. A test
// driving clicks would prove it for two dates; this proves it for the shape.
import { describe, it, expect } from "vitest";
import { nextRange, tentativeSpan, parseISODate, toISODate } from "./DateRangePicker";

const t = (iso: string): number => parseISODate(iso)!;

describe("#649: a range never leaves this control backwards", () => {
  it("completes the range when the second day is EARLIER than the first", () => {
    const r = nextRange({ from: "2026-08-20" }, t("2026-08-14"));
    expect(r, "the earlier click becomes the start, not a new selection").toEqual({
      from: "2026-08-14",
      to: "2026-08-20",
    });
  });

  it("completes it the ordinary way round too", () => {
    expect(nextRange({ from: "2026-08-14" }, t("2026-08-20"))).toEqual({
      from: "2026-08-14",
      to: "2026-08-20",
    });
  });

  it("both orders of the same two days give the same range", () => {
    // The property the ticket is about: the reader's route through the calendar does not change the
    // answer. A single worked example would pass against an implementation that swapped only sometimes.
    for (const [a, b] of [["2026-08-14", "2026-08-20"], ["2026-01-31", "2026-02-01"], ["2025-12-31", "2026-01-01"]]) {
      const forwards = nextRange({ from: a }, t(b!));
      const backwards = nextRange({ from: b }, t(a!));
      expect(backwards, `${a} ⇄ ${b}`).toEqual(forwards);
      expect(forwards.from! <= forwards.to!, `${a} ⇄ ${b} is ordered`).toBe(true);
    }
  });

  it("a click on the same day is a one-day range, not a restart", () => {
    expect(nextRange({ from: "2026-08-14" }, t("2026-08-14"))).toEqual({ from: "2026-08-14", to: "2026-08-14" });
  });

  it("starts a new range when one is already complete", () => {
    expect(nextRange({ from: "2026-08-01", to: "2026-08-31" }, t("2026-08-10")))
      .toEqual({ from: "2026-08-10", to: undefined });
  });

  it("the first click of all just starts", () => {
    expect(nextRange({}, t("2026-08-10"))).toEqual({ from: "2026-08-10", to: undefined });
  });
});

describe("#649: the faint band while a second endpoint is being considered", () => {
  it("spans from the chosen start to the day under consideration, in either direction", () => {
    const back = tentativeSpan(t("2026-08-20"), null, t("2026-08-14"));
    expect(back && [toISODate(back.lo), toISODate(back.hi)]).toEqual(["2026-08-14", "2026-08-20"]);
    const fwd = tentativeSpan(t("2026-08-14"), null, t("2026-08-20"));
    expect(fwd && [toISODate(fwd.lo), toISODate(fwd.hi)]).toEqual(["2026-08-14", "2026-08-20"]);
  });

  it("draws nothing when there is nothing to promise", () => {
    expect(tentativeSpan(null, null, t("2026-08-14")), "no start chosen yet").toBeNull();
    expect(tentativeSpan(t("2026-08-01"), t("2026-08-31"), t("2026-08-14")), "range already complete").toBeNull();
    expect(tentativeSpan(t("2026-08-01"), null, null), "nothing under the pointer or focus").toBeNull();
  });
});
