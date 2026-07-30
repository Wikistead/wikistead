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

const src = readFileSync(resolve(import.meta.dirname, "./TenantRoleAssignments.tsx"), "utf8");

describe("#557: tenant assignment picks members by search, not enumeration", () => {
  it("uses the shared MemberSearchInput on the member field", () => {
    expect(src).toContain('import { MemberSearchInput } from "../ui/MemberSearchInput"');
    expect(src).toMatch(/inputTestId="tenant-assign-member"/);
  });

  it("the every-member dropdown stays gone", () => {
    // the old shape mapped the FULL member list into Select options
    expect(src).not.toMatch(/Select[^]*?members\.map/);
    expect(src).not.toMatch(/testId="tenant-assign-member"/); // the Select prop spelling — the picker uses inputTestId
  });

  it("what gets sent is unchanged: the pick resolves to a user:<sub> principal", () => {
    expect(src).toMatch(/principal: `user:\$\{sub\}`/);
  });
});
