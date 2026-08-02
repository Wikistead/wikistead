// #579: the member row is the only place a tenant role is given or taken. What that row shows is
// decided here, as data, for the reason #536taught — the bug that granted a role to nobody
// lived in an inline click handler nothing could test.
//
// The asymmetry is the whole point: the built-in role is EXACTLY ONE (a column on the member, so
// picking admin unpicks member) while custom roles are a SET (each one an assignment row). A single
// Select cannot express both, and the old screen dodged that by having two surfaces — a Select on the
// row and a separate form above the table, which is what the user tripped over ("oh, THAT's what the
// top half was").
import { describe, it, expect } from "vitest";
import { buildTenantRoleRows, buildGroupRoleRows, filterMembers, pickerOptions, resolveRoleChoice, type TenantAssignment, type RowMember } from "./tenant-role-rows";

const m = (sub: string, role: "admin" | "member" = "member", name: string | null = null): RowMember =>
  ({ sub, role, display_name: name, email: `${sub}@x.test` });
const a = (id: string, roleId: string, roleName: string, principal: string, extra: Partial<TenantAssignment> = {}): TenantAssignment =>
  ({ id, roleId, roleName, principal, ...extra });
const ROLES = [
  { id: "r1", name: "Space creators", scope: "tenant" },
  { id: "r2", name: "Key issuers", scope: "tenant" },
  { id: "r3", name: "Space editors", scope: "resource" }, // NOT assignable here
];

describe("#579: the member row carries every tenant role that member holds", () => {
  it("shows the built-in as one value and the custom ones as a set", () => {
    const rows = buildTenantRoleRows(
      [m("alice", "admin"), m("bob")],
      [a("as1", "r1", "Space creators", "user:alice"), a("as2", "r2", "Key issuers", "user:alice")],
      ROLES,
    );
    const alice = rows.find((r) => r.sub === "alice")!;
    expect(alice.builtin, "exactly one, and it is the member column").toBe("admin");
    expect(alice.custom.map((c) => c.roleName).sort()).toEqual(["Key issuers", "Space creators"]);
    expect(rows.find((r) => r.sub === "bob")!.custom, "nobody holds a role by default").toEqual([]);
  });

  it("each custom role keeps its OWN assignment id — removal is per assignment, not per capability", () => {
    //two roles can confer the same capability, and the server's reference count decides what
    // actually goes. A chip that removed "the capability" would take the other role's grant with it.
    const rows = buildTenantRoleRows([m("alice")], [
      a("as1", "r1", "Space creators", "user:alice"),
      a("as2", "r2", "Key issuers", "user:alice"),
    ], ROLES);
    expect(rows[0]!.custom.map((c) => c.assignmentId)).toEqual(["as1", "as2"]);
  });

  it("offers only roles the member does NOT hold, and only TENANT-scope ones", () => {
    const rows = buildTenantRoleRows([m("alice")], [a("as1", "r1", "Space creators", "user:alice")], ROLES);
    expect(rows[0]!.addable.map((r) => r.id), "r1 is held; r3 belongs to a space, not to a person").toEqual(["r2"]);
  });

  it("a mapping-owned assignment is marked, so the row can drop its × (the server refuses anyway)", () => {
    const rows = buildTenantRoleRows([m("alice")], [a("as1", "r1", "Space creators", "user:alice", { managed: true })], ROLES);
    expect(rows[0]!.custom[0]!.managed, "ADR-183 §1: the mapping owns it").toBe(true);
  });

  // HONEST STATUS: an invariant, not a verified regression pin. Removing the `user:` guard does NOT
  // turn this red — a group principal simply keys under "abc#member", which matches no member's sub,
  // so the row stays empty for a second reason. It is asserted because the rule matters (a group is
  // not a person on this table), not because a plausible edit is known to break it.
  it("GROUP assignments never appear on a member row — there is no member to hang them on", () => {
    const rows = buildTenantRoleRows([m("alice")], [
      a("as1", "r1", "Space creators", "group:abc#member", { groupName: "Engineering" }),
    ], ROLES);
    expect(rows[0]!.custom, "a group is not a person on this table").toEqual([]);
  });
});

describe("#579: groups get their own section, named the way the server named them", () => {
  it("groups one row per group, with the server-resolved name", () => {
    const rows = buildGroupRoleRows([
      a("as1", "r1", "Space creators", "group:abc#member", { groupName: "Engineering" }),
      a("as2", "r2", "Key issuers", "group:abc#member", { groupName: "Engineering" }),
      a("as3", "r1", "Space creators", "user:alice"),
    ], "unknown group", "group");
    expect(rows.length, "one row per group, not per assignment").toBe(1);
    expect(rows[0]!.label).toBe("Engineering (group)");
    expect(rows[0]!.held.map((h) => h.roleName).sort()).toEqual(["Key issuers", "Space creators"]);
  });

  it("an id nobody can name gets the explicit label, never the raw hash, and keeps its removal", () => {
    const rows = buildGroupRoleRows([a("as1", "r1", "Space creators", "group:a13d1861deadbeef#member")], "unknown group", "group");
    expect(rows[0]!.label, "the hash must not reach the screen (#536⑥)").toBe("unknown group (group)");
    expect(rows[0]!.label).not.toContain("a13d1861");
    expect(rows[0]!.held[0]!.managed, "still revocable — an orphan is not machine-managed").toBe(false);
  });
});

describe("#579: finding a member is a filter over the table, not a picker inside a form", () => {
  const people = [m("alice", "member", "Alice Adams"), m("bob", "member", "Bob Brown"), m("carol")];

  it("matches name, email or sub, and an empty query keeps everyone", () => {
    expect(filterMembers(people, "").length).toBe(3);
    expect(filterMembers(people, "alice").map((x) => x.sub)).toEqual(["alice"]);
    expect(filterMembers(people, "BOB@X").map((x) => x.sub), "case-insensitive, and email counts").toEqual(["bob"]);
    expect(filterMembers(people, "carol").map((x) => x.sub), "a member with no display name is still findable").toEqual(["carol"]);
    expect(filterMembers(people, "   ").length, "whitespace is not a filter").toBe(3);
  });

  it("does not mutate the list it was given", () => {
    const before = [...people];
    filterMembers(people, "alice");
    expect(people).toEqual(before);
  });
});

// #579 review: "why are the built-in and custom role UIs separate? put them in the same
// selector." The row had a Select for the tier and a button that opened a second Select for custom
// roles. One picker now offers both, so the decision — is this pick a tier swap or a role addition —
// lives here, where it can be tested, rather than in the handler.
describe("#579 review: one picker, two mechanisms underneath", () => {
  const row = buildTenantRoleRows(
    [m("alice", "member")],
    [a("as1", "r1", "Space creators", "user:alice")],
    ROLES,
  )[0]!;

  it("offers the tier the member is NOT on, plus the roles they do not hold", () => {
    expect(pickerOptions(row)).toEqual([
      { value: "tier:admin", label: "admin" },
      { value: "role:r2", label: "Key issuers" },
    ]);
  });

  it("an admin is offered member, not admin again", () => {
    const adminRow = buildTenantRoleRows([m("bob", "admin")], [], ROLES)[0]!;
    expect(pickerOptions(adminRow)[0]).toEqual({ value: "tier:member", label: "member" });
  });

  it("resolves a tier pick to a tier change and a role pick to an assignment", () => {
    expect(resolveRoleChoice("tier:admin", row.addable)).toEqual({ kind: "tier", role: "admin" });
    expect(resolveRoleChoice("role:r2", row.addable)).toEqual({ kind: "custom", roleId: "r2" });
  });

  it("refuses anything it did not offer — a stale id, the placeholder, a hand-made value", () => {
    for (const v of ["", "role:r1", "role:nope", "admin", "tier:owner", "role:"]) {
      expect(resolveRoleChoice(v, row.addable).kind, `${v} must not dispatch`).toBe("none");
    }
  });

  it("a custom role NAMED admin cannot be mistaken for the tier (the prefix carries the mechanism)", () => {
    const roles = [...ROLES, { id: "r9", name: "admin", scope: "tenant" }];
    const r = buildTenantRoleRows([m("carol")], [], roles)[0]!;
    const opts = pickerOptions(r);
    expect(opts.filter((o) => o.label === "admin").map((o) => o.value).sort()).toEqual(["role:r9", "tier:admin"]);
    expect(resolveRoleChoice("role:r9", r.addable)).toEqual({ kind: "custom", roleId: "r9" });
  });
});
