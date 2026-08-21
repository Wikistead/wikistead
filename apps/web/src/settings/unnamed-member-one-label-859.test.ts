// #859: a member the product cannot name reads the same on every screen.
//
// #578 met this on four surfaces and wrote `memberLabel` for it. The screens written afterwards did
// not use it: the roster fell back through a FIELD — `m.display_name || m.email || m.sub` — ten times
// on one page, and five more sites did the same with `c.displayName || c.sub`. The pin from #578 could
// not see any of them, because it reads a BARE identifier (`|| sub`) and a principal being unwrapped.
//
// This measures the RESULT rather than the call: a member with no name goes through the row builder
// and the label, and both have to produce the one string. Asserting that a helper exists proves
// nothing about the screens that were not calling it.
import { describe, it, expect } from "vitest";
import { buildUnifiedRows } from "./tenant-role-rows";
import { memberLabel, shortPrincipalId } from "../ui/principal-label";

const UNKNOWN = "Unnamed member";
const LONG = "89e72bb9f2d5effccbf6fe2784f01fe06057f960f06ccb109ef4a0cdef17791c";

describe("#859 one wording for a member with no name", () => {
  it("the roster row does not print the subject id", () => {
    const rows = buildUnifiedRows(
      [{ sub: LONG, display_name: null, email: null, role: "member", groups: null }],
      [], new Set(), [], UNKNOWN,
    );
    const row = rows.find((r) => r.kind === "user")!;
    expect(row.label, "a 64-character hex string is not a name").not.toContain(LONG);
    expect(row.label).toBe(`${UNKNOWN} (${shortPrincipalId(LONG)})`);
  });

  it("and the label a screen builds directly says exactly the same thing", () => {
    // The two paths that render an unnamed member — the row builder and a call site — must agree, or
    // the same person reads differently depending on which screen you are on. That is the defect.
    const rows = buildUnifiedRows(
      [{ sub: LONG, display_name: null, email: null, role: "member", groups: null }],
      [], new Set(), [], UNKNOWN,
    );
    expect(rows.find((r) => r.kind === "user")!.label).toBe(memberLabel(LONG, null, UNKNOWN));
  });

  it("an email still names somebody in the admin's own roster", () => {
    // The roster is the admin's, and knowing who was invited is what the column is for. Only the last
    // resort — the id — was never a name.
    const rows = buildUnifiedRows(
      [{ sub: LONG, display_name: null, email: "ada@example.test", role: "member", groups: null }],
      [], new Set(), [], UNKNOWN,
    );
    expect(rows.find((r) => r.kind === "user")!.label).toBe("ada@example.test");
  });

  it("a blank name is not a name", () => {
    const rows = buildUnifiedRows(
      [{ sub: LONG, display_name: "   ", email: null, role: "member", groups: null }],
      [], new Set(), [], UNKNOWN,
    );
    expect(rows.find((r) => r.kind === "user")!.label).toBe(`${UNKNOWN} (${shortPrincipalId(LONG)})`);
  });
});
