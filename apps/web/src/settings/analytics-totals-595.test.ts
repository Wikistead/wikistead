// #595: the member total is a head-count, and head-counts do not add up.
//
// The dashboard summed the daily rows for every class. That is right for views and wrong for people: in
// unique mode a day's member figure is that day's DISTINCT members, so a member who read on Monday and
// again on Tuesday appeared twice in a number labelled "members". The server now answers the period-wide
// distinct (it is the one holding the roster); the client's job is to prefer it, and to leave guests and
// anon alone, since nothing durable identifies them across days.
import { describe, it, expect } from "vitest";
import { analyticsTotals } from "./AnalyticsDashboard";

const daily = [
  { day: "2026-06-10", viewerClass: "member" as const, views: 2 },
  { day: "2026-06-11", viewerClass: "member" as const, views: 2 },
  { day: "2026-06-12", viewerClass: "member" as const, views: 1 },
  { day: "2026-06-10", viewerClass: "guest" as const, views: 4 },
  { day: "2026-06-11", viewerClass: "anon" as const, views: 3 },
];

describe("#595: analyticsTotals", () => {
  it("prefers the server's period-wide distinct over the sum of the days", () => {
    const t = analyticsTotals({ daily, memberUnique: 3 });
    expect(t.member, "three people, not the five person-days").toBe(3);
  });

  it("still sums guests and anon — there is no id to de-duplicate them by", () => {
    const t = analyticsTotals({ daily, memberUnique: 3 });
    expect(t.guest).toBe(4);
    expect(t.anon).toBe(3);
  });

  it("falls back to the sum when the server did not answer (raw mode)", () => {
    const t = analyticsTotals({ daily });
    expect(t.member, "in raw mode the daily figures ARE views, so summing is correct").toBe(5);
  });

  it("reads zero as zero, not as absent", () => {
    // A period in which nobody read anything answers 0, and `??` must not mistake that for "no answer"
    // and fall back to a sum. It is the difference between "nobody came" and "we did not ask".
    expect(analyticsTotals({ daily, memberUnique: 0 }).member).toBe(0);
  });

  it("survives no data at all", () => {
    expect(analyticsTotals(null)).toEqual({ member: 0, guest: 0, anon: 0 });
    expect(analyticsTotals(undefined)).toEqual({ member: 0, guest: 0, anon: 0 });
  });
});
