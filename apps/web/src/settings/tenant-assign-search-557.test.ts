// #557: the tenant role-assignment member field is the SHARED #416 search picker (MemberSearchInput),
// not an every-member <Select>. The reviewer's sweep found this was the LAST member-enumerating
// dropdown in apps/web/src; this pins that it stays gone and stays the shared component (one picker for
// every "pick a member" surface — the same look as the space Members tab).
//
// Lexical, deliberately (the one-add-control-536 precedent): the behaviour (typing filters, names show,
// pick → assign) is covered by the admin-roles-420 e2e; what must not come back is the enumerating form.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #579 removed the separate assign form: a tenant role is chosen on the member's own ROW, and the
// "find the person" problem it solved is now a filter over the table itself. The subject of this pin
// moves with it — what must never come back is a control that ENUMERATES members.
const src = readFileSync(resolve(import.meta.dirname, "./MembersPage.tsx"), "utf8");

describe("#557: members are found by search, never enumerated into a control", () => {
  it("the table has a filter, and it is the only 'find a member' affordance", () => {
    expect(src).toMatch(/data-testid="members-filter"/);
    expect(src).toContain("filterMembers(members, filter)");
  });

  it("the every-member dropdown stays gone", () => {
    // the old shape mapped the FULL member list into Select options
    expect(src).not.toMatch(/Select[^]*?members\.map/);
    expect(src).not.toMatch(/testId="tenant-assign-member"/);
  });

  it("what gets sent is unchanged: the row assigns to a user:<sub> principal", () => {
    expect(src).toMatch(/principal: `user:\$\{m\.sub\}`/);
  });
});
