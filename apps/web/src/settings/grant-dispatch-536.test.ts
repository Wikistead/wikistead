// #536 review point 7: the merged picker's dispatch, exercised as behaviour — all four combinations of
// {user, group} × {built-in, custom role}. The bug (a hand-built `group:<name>#member` principal
// that pointed at nothing) lived exactly here, inside a click handler no test could reach; the decision
// is a pure function now, so the four cases are values.
import { describe, it, expect } from "vitest";
import { resolveGrantDispatch } from "./grant-dispatch";

const MEMBER = { grantee: "user:alice" };

describe("#536: the merged picker dispatch, four ways", () => {
  // #553 / ADR-199 §2: this pin FLIPPED deliberately — the editor NOUN is now a composite (edit +
  // comment as N single-capability grants; the subsumption the model loses is delivered by the bundle,
  // exactly where the noun is offered). Every non-composite built-in keeps the single-grant shape.
  it("user × built-in editor NOUN → the composite grant path with the bundle (#553 flip)", () => {
    expect(resolveGrantDispatch({ pick: "builtin:edit", mode: "user", picked: MEMBER, groupName: "" }))
      .toEqual({ path: "grant-composite", capabilities: ["edit", "comment"], target: { kind: "user", principal: "user:alice" } });
  });

  it("user × non-composite built-in → the single grant path, unchanged", () => {
    expect(resolveGrantDispatch({ pick: "builtin:view", mode: "user", picked: MEMBER, groupName: "" }))
      .toEqual({ path: "grant", capability: "view", target: { kind: "user", principal: "user:alice" } });
  });

  it("user × custom role → the assignment path with the role id", () => {
    expect(resolveGrantDispatch({ pick: "role:r-1", mode: "user", picked: MEMBER, groupName: "" }))
      .toEqual({ path: "assign", roleId: "r-1", target: { kind: "user", principal: "user:alice" } });
  });

  it("group × built-in → the grant path carrying the NAME, no principal anywhere", () => {
    const a = resolveGrantDispatch({ pick: "builtin:view", mode: "group", picked: null, groupName: "writers" });
    expect(a).toEqual({ path: "grant", capability: "view", target: { kind: "group", groupName: "writers" } });
    // the shape must be unrepresentable in the result, not merely avoided
    expect(JSON.stringify(a)).not.toContain("group:");
  });

  it("group × custom role → the assignment path carrying the NAME (the case itself)", () => {
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

// #497 (088): the mapping picker's decision, same discipline.
import { resolveMappingDispatch } from "./grant-dispatch";

describe("#497: resolveMappingDispatch", () => {
  it("dispatches builtin and role picks by prefix", () => {
    expect(resolveMappingDispatch("builtin:edit")).toEqual({ kind: "builtin", builtinCapability: "edit" });
    expect(resolveMappingDispatch("role:abc-123")).toEqual({ kind: "role", roleId: "abc-123" });
  });
  it("maps nothing for empty, prefix-only, or unrecognised values (never a broken wire field)", () => {
    for (const v of ["", "builtin:", "role:", "someid", "BUILTIN:edit"]) {
      expect(resolveMappingDispatch(v), v).toEqual({ kind: "none" });
    }
  });
});

// #553 review F: the display fold and its revoke set, pinned as values (the component only executes).
import { foldGrantsByPrincipal, revokeCapsForRow } from "./grant-dispatch";

// #607 ("Dev User" showed twice, flagged as a likely bug): the roster answers one row per CAPABILITY,
// and a principal holding several of them appeared several times. #553's editor fold already merged one
// specific pair; this is that rule generalised, so the screen shows what #536 / #579 settled — one
// principal, one role.
describe("#607 / #553: foldGrantsByPrincipal / revokeCapsForRow", () => {
  const g = (grantee: string, capability: string) => ({ grantee, capability });
  const folded = (rows: { grantee: string; capability: string }[]) =>
    Object.fromEntries(foldGrantsByPrincipal(rows).map((f) => [f.row.grantee, f]));

  it("gives each principal exactly one row, whatever they hold", () => {
    const rows = [
      g("user:owner", "manage"), g("user:owner", "view"),
      g("user:pair", "edit"), g("user:pair", "comment"),
      g("user:viewer", "view"),
    ];
    const out = foldGrantsByPrincipal(rows);
    expect(out.length, "one row per principal").toBe(3);
    expect(new Set(out.map((f) => f.row.grantee)).size, "and no principal twice").toBe(3);
  });

  it("the row shown is the strongest thing held — the owner is a manager, not a viewer", () => {
    // The motivating data exactly: the space's owner carries the structural `manage` mark AND an
    // explicit `view` grant. Drawing the `view` row is what offered a role change that could never work.
    const f = folded([g("user:owner", "view"), g("user:owner", "manage")]);
    expect(f["user:owner"]!.row.capability).toBe("manage");
  });

  it("is order-blind: which grant the server listed first cannot change the answer", () => {
    const a = folded([g("g:1#member", "comment"), g("g:1#member", "view"), g("g:1#member", "edit")]);
    const b = folded([g("g:1#member", "edit"), g("g:1#member", "comment"), g("g:1#member", "view")]);
    expect(a["g:1#member"]!.row.capability).toBe("edit");
    expect(b["g:1#member"]!.row.capability).toBe("edit");
  });

  it("the folded row stands for everything it replaced, so nothing becomes unremovable", () => {
    const f = folded([g("user:pair", "edit"), g("user:pair", "comment")]);
    expect(new Set(f["user:pair"]!.foldedCaps)).toEqual(new Set(["edit", "comment"]));
    expect(revokeCapsForRow({ capability: "edit", foldedCaps: ["edit", "comment"] })).toEqual(["edit", "comment"]);
    expect(revokeCapsForRow({ capability: "comment" })).toEqual(["comment"]);
  });

  it("an unrecognised capability sorts last rather than winning the row", () => {
    // A capability this build does not know about must not outrank `manage` and relabel the owner.
    const f = folded([g("user:x", "manage"), g("user:x", "whatever-comes-next")]);
    expect(f["user:x"]!.row.capability).toBe("manage");
  });
});
