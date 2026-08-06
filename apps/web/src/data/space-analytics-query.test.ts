import { describe, it, expect } from "vitest";
import { spaceAnalyticsQuery } from "./queries";

// #520 slice 4: the space-analytics shaping params → query string. Only non-empty params are sent so an
// untouched control never over-constrains the roll-up, and `unique` maps to the literal 'true' the server
// checks. (Authz is server-side; this is just the presentation params the endpoint validates.)
describe("spaceAnalyticsQuery (#520 slice 4)", () => {
  it("omits every empty param (a fresh dashboard sends no query)", () => {
    expect(spaceAnalyticsQuery({})).toBe("");
    // #648: the second case here used to serialise `sort`/`dir`. Those params are gone — the control
    // that sent them changed the request and never the picture — so the claim is re-aimed at a param
    // that still exists rather than deleted: a set value is carried, an unset one is not.
    expect(spaceAnalyticsQuery({ viewerClass: "member" })).toBe("viewerClass=member");
  });

  it("serialises period / class filters and encodes values", () => {
    const q = new URLSearchParams(spaceAnalyticsQuery({ from: "2026-07-01", to: "2026-07-31", viewerClass: "guest" }));
    expect(q.get("from")).toBe("2026-07-01");
    expect(q.get("to")).toBe("2026-07-31");
    expect(q.get("viewerClass")).toBe("guest");
  });

  it("maps unique=true to the literal the endpoint checks; false/undefined omit it", () => {
    expect(new URLSearchParams(spaceAnalyticsQuery({ unique: true })).get("unique")).toBe("true");
    expect(spaceAnalyticsQuery({ unique: false })).toBe("");
    expect(spaceAnalyticsQuery({})).not.toContain("unique");
  });
});
