// #536 review 7: the merged picker's dispatch, exercised as behaviour — all four combinations of
// {user, group} × {built-in, custom role}. Thebug (a hand-built `group:<name>#member` principal
// that pointed at nothing) lived exactly here, inside a click handler no test could reach; the decision
// is a pure function now, so the four cases are values.
import { describe, it, expect } from "vitest";
import { resolveGrantDispatch } from "./grant-dispatch";

const MEMBER = { grantee: "user:alice" };

describe("#536: the merged picker dispatch, four ways", () => {
  it("user × built-in → the grant path with the capability", () => {
    expect(resolveGrantDispatch({ pick: "builtin:edit", mode: "user", picked: MEMBER, groupName: "" }))
      .toEqual({ path: "grant", capability: "edit", target: { kind: "user", principal: "user:alice" } });
  });

  it("user × custom role → the assignment path with the role id", () => {
    expect(resolveGrantDispatch({ pick: "role:r-1", mode: "user", picked: MEMBER, groupName: "" }))
      .toEqual({ path: "assign", roleId: "r-1", target: { kind: "user", principal: "user:alice" } });
  });

  it("group × built-in → the grant path carrying the NAME, no principal anywhere", () => {
    const a = resolveGrantDispatch({ pick: "builtin:view", mode: "group", picked: null, groupName: "writers" });
    expect(a).toEqual({ path: "grant", capability: "view", target: { kind: "group", groupName: "writers" } });
    // theshape must be unrepresentable in the result, not merely avoided
    expect(JSON.stringify(a)).not.toContain("group:");
  });

  it("group × custom role → the assignment path carrying the NAME (thecase itself)", () => {
    const a = resolveGrantDispatch({ pick: "role:r-2", mode: "group", picked: null, groupName: "site ops" });
    expect(a).toEqual({ path: "assign", roleId: "r-2", target: { kind: "group", groupName: "site ops" } });
    expect(JSON.stringify(a)).not.toContain("#member");
  });

  it("nothing chosen, nothing sent — every degenerate input resolves to none", () => {
    // A dispatch that guesses under partial input is how a success toast gets earned by nothing.
    for (const args of [
      { pick: "builtin:view", mode: "user" as const, picked: null, groupName: "" },
      { pick: "builtin:view", mode: "group" as const, picked: MEMBER, groupName: "" }, // group mode ignores picked
      { pick: "role:", mode: "user" as const, picked: MEMBER, groupName: "" },
      { pick: "builtin:", mode: "user" as const, picked: MEMBER, groupName: "" },
      { pick: "something-else", mode: "user" as const, picked: MEMBER, groupName: "" },
    ]) {
      expect(resolveGrantDispatch(args), JSON.stringify(args)).toEqual({ path: "none" });
    }
  });

  it("the member principal passes through verbatim — this module never builds one", () => {
    const a = resolveGrantDispatch({ pick: "builtin:view", mode: "user", picked: { grantee: "user:weird sub with spaces" }, groupName: "" });
    expect(a).toMatchObject({ target: { principal: "user:weird sub with spaces" } });
  });
});
