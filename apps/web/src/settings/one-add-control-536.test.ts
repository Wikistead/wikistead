// #536 / ADR-188 §6: giving someone access to a space is ONE control.
//
// The screen used to have two: a capability picker at the top, and a separate "custom roles" form lower
// down with its own role select, its own member search, and its own Add button. Which one you needed
// depended on how the permission happened to be implemented server-side — a distinction the person
// granting access has no reason to care about, and cannot see.
//
// The duplication was not only a usability cost. The second form built its principal string itself
// (`user:${sub}`), and thegroup bug was exactly that: a second place constructing a principal, free
// to be wrong while the first one is right. One control means one construction site.
//
// Lexical, deliberately. What is being pinned is that a SECOND path does not come back — a behavioural
// test of the surviving path would stay green the day someone adds a third form beside it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(import.meta.dirname, "./SpaceMembersTab.tsx"), "utf8");

describe("#536: space access is granted from one control", () => {
  it("has exactly one add button", () => {
    const adds = src.match(/data-testid="[a-z-]*add"/g) ?? [];
    expect(adds, `one Add control, found ${JSON.stringify(adds)}`).toEqual(['data-testid="space-grant-add"']);
  });

  it("has exactly one member search input", () => {
    // Two searches meant picking a person twice depending on what you were about to give them.
    expect(src.match(/<MemberSearchInput/g) ?? []).toHaveLength(1);
  });

  it("constructs a user principal in exactly one place", () => {
    // The interpolation itself — the shape the group bug came in through. The grant path sends the
    // grantee it was handed; only the merged dispatch builds one.
    const built = src.match(/`user:\$\{[^}]+\}`/g) ?? [];
    expect(built.length, `one principal construction site, found ${JSON.stringify(built)}`).toBeLessThanOrEqual(1);
  });

  it("never builds a group principal — the server derives that id", () => {
    // A tenant-salted hash cannot be guessed here. Sending a name is the whole fix; this is the pin that
    // says so at the one place a future edit would be tempted to "simplify" it back.
    expect(src).not.toMatch(/`group:\$\{/);
  });

  it("still LISTS role assignments — now inside the ONE merged member list (#536①)", () => {
    // The merge must not lose the assignments: an assignment is a role the grant machinery cannot show,
    // and its revoke must still reach the assignment mechanism. The old split list testids are GONE —
    // the red-check: they must not coexist with the merged list.
    expect(src).toContain('data-testid="space-member-list"');
    expect(src).toContain('data-testid="space-role-assign-revoke"');
    expect(src).not.toContain('data-testid="space-role-assign-list"');
    expect(src).not.toContain('data-testid="space-grant-list"');
  });

  it("renders assignments unconditionally — never gated on the assignable-roles list", () => {
    // An entitlement lapse empties the assignable-roles list while the assignments themselves live on as
    // FGA tuples. The merged list renders mergedRows (grants + assignments) with no customRoles guard,
    // so an assignment you hold is always one you can see and revoke.
    const at = src.indexOf('data-testid="space-member-list"');
    const before = src.slice(Math.max(0, at - 400), at);
    expect(before, "no customRoles-length gate wraps the merged list").not.toMatch(/customRoles\.length/);
  });
});
