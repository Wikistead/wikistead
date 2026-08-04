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
import { buildTenantRoleRows, buildGroupRoleRows, filterMembers, roleOptions, currentRoleValue, resolveRoleChoice, BUILT_IN_TIERS, type TenantAssignment, type RowMember } from "./tenant-role-rows";

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
// roles. One picker now offers both, so the decision — is this pick a tier swap or a role addition
// lives here, where it can be tested, rather than in the handler.
// RE-AIMED by #579 (2026-08-03 ruling): the picker used to offer "the tier you are NOT on plus the
// roles you do not hold", because the row drew what you HAD as chips beside it. Roles do not stack
// the server converges a tenant principal to one (a71d8100) — so the control now shows the role itself
// and offers the whole vocabulary. Asserting the old option list would be asserting the additive model
// this ticket removed.
describe("#579: one control, showing the role the member has", () => {
  const row = buildTenantRoleRows(
    [m("alice", "member")],
    [a("as1", "r1", "Space creators", "user:alice")],
    ROLES,
  )[0]!;

  it("offers every tier and every tenant role — including the one they hold", () => {
    // a control whose value is the current role must be able to SHOW it; hiding held roles is what
    // forced the chips
    expect(roleOptions(ROLES).map((o) => [o.value, o.label])).toEqual([
      ["tier:member", "member"],
      ["tier:admin", "admin"],
      ["role:r1", "Space creators"],
      ["role:r2", "Key issuers"],
    ]);
    // #579 (2026-08-04): the TIERS carry what they confer when the caller knows it — they used to
    // arrive bare and shipped silent on hover while the custom roles explained themselves. #582 ①
    // decided WHERE the answer comes from (the tenant's live defaults for `member`, since that
    // capability rides a per-tenant switch), so given those defaults no tier is left without a source.
    const tiers = roleOptions(ROLES, { member: ["createSpaces"], admin: ["manageRoles"] })
      .filter((o) => o.value.startsWith("tier:"));
    expect(tiers.length, "there are tiers to check").toBeGreaterThan(0);
    expect(tiers.filter((o) => o.roleCapabilities === undefined), "a tier offered with nothing to reveal").toEqual([]);
  });

  it("shows the custom role when they hold one, and their tier when they do not", () => {
    expect(currentRoleValue(row)).toBe("role:r1");
    const plain = buildTenantRoleRows([m("bob", "admin")], [], ROLES)[0]!;
    expect(currentRoleValue(plain)).toBe("tier:admin");
  });

  it("a row carrying more than one role (data from before the convergence) still shows one value", () => {
    const two = buildTenantRoleRows(
      [m("carol", "member")],
      [a("as1", "r1", "Space creators", "user:carol"), a("as2", "r2", "Key issuers", "user:carol")],
      ROLES,
    )[0]!;
    expect(currentRoleValue(two), "one value, and choosing anything folds the rest server-side").toBe("role:r1");
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
    const opts = roleOptions(roles);
    expect(opts.filter((o: { label: string }) => o.label === "admin").map((o: { value: string }) => o.value).sort()).toEqual(["role:r9", "tier:admin"]);
    expect(resolveRoleChoice("role:r9", roles.filter((x) => x.scope === "tenant"))).toEqual({ kind: "custom", roleId: "r9" });
    void r;
  });
});

// #582 (user ruling): "member admin ". A built-in role name is a
// proper noun — the same string on every screen and in every locale. Before this, the tenant screens
// translated these two / ) while the space screen showed viewer/editor/moderator/manager
// in English, so one role had two names depending on where you looked. The pin mirrors the real list
// rather than copying it, because a hand-written copy is what rotted the last three copy pins.
describe("#582: built-in role names are proper nouns", () => {
  it("the tier list is exported so every surface and this pin read the same thing", () => {
    expect([...BUILT_IN_TIERS]).toEqual(["member", "admin"]);
  });

  it("no locale carries a translation for them any more", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const loc of ["en", "ja"]) {
      const j = JSON.parse(readFileSync(resolve(import.meta.dirname, `../i18n/locales/${loc}.json`), "utf8"));
      expect(j.members.roleMember, `${loc}: the translated tier name is gone`).toBeUndefined();
      expect(j.members.roleAdmin, `${loc}`).toBeUndefined();
      // and nothing else in this section reintroduces them by another key
      const values = Object.values(j.members).filter((v): v is string => typeof v === "string");
      expect(values, `${loc}: no key spells a tier in prose`).not.toContain("管理者");
    }
  });

  it("the picker labels a tier with its own name, not a translation key", () => {
    expect(roleOptions(ROLES).map((o: { label: string }) => o.label)).toContain("admin");
  });
});

// ADR-207 (#603, overturns ADR-201 §1): a group may hold the tenant tier now, so the sentence that
// explained the tiers' absence lost its subject — the absence itself is gone. The note, its locale
// keys and the pins that guarded them go together (; leaving the keys behind is the #582
// orphan-key mistake).
describe("#603: the group picker offers the tiers, and the note that explained their absence is gone", () => {
  it("no locale carries the note key", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const loc of ["en", "ja"]) {
      const j = JSON.parse(readFileSync(resolve(import.meta.dirname, `../i18n/locales/${loc}.json`), "utf8"));
      expect(j.adminRoles.groupTiersNote, `${loc}: the orphan key is gone`).toBeUndefined();
    }
  });

  it("the member table no longer renders it, and the group surfaces read the row vocabulary", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(import.meta.dirname, "./MembersPage.tsx"), "utf8");
    expect(src, "the note testid is gone").not.toContain("tenant-group-tiers-note");
    expect(src, "the note key is not referenced").not.toContain("adminRoles.groupTiersNote");
    // the group row and the add-form both build their options from the shared list-builder — the same
    // tiers-and-custom vocabulary a person's row reads
    // #582 ①: the call now carries the tenant's live tier capabilities as a second argument, so the pin
    // counts the BUILDER rather than one exact spelling of the call — the subject is "every picker on
    // this screen goes through it", which an argument list must not be able to break.
    const uses = src.split("roleOptions(roles.data?.custom ?? []").length - 1;
    expect(uses, "member row + group row + add form + invite all share the one list-builder").toBeGreaterThanOrEqual(4);
  });

  it("a tier pick and a custom pick keep their mechanisms apart on a group", () => {
    // the value prefix carries the mechanism (the same guard the person row pins above): a custom role
    // NAMED admin resolves to an assignment, the tier to the tier grant
    const opts = roleOptions([{ id: "r9", name: "admin", scope: "tenant" }]);
    expect(opts.filter((o: { label: string }) => o.label === "admin").map((o: { value: string }) => o.value).sort()).toEqual(["role:r9", "tier:admin"]);
    expect(resolveRoleChoice("tier:admin", [])).toEqual({ kind: "tier", role: "admin" });
    expect(resolveRoleChoice("role:r9", [{ id: "r9", name: "admin", scope: "tenant" }])).toEqual({ kind: "custom", roleId: "r9" });
  });
});

// #578 bounce ①: a group nobody carries yet keeps its name. The row used to fall back to "unknown
// group" the moment the name had nowhere to live, which told the manager their grant had gone wrong
// when it had not. Two facts, two labels: "not seen yet" resolves itself when someone signs in;
// "unknown group" means the id names nothing at all and never will unless the IdP brings it back.
describe("#578 ①: the group row distinguishes 'not seen yet' from 'unknown'", () => {
  const groupRow = (extra: Partial<TenantAssignment>) =>
    buildGroupRoleRows([a("as1", "r1", "Space creators", "group:abc#member", extra)], "unknown group", "group", "not seen yet")[0]!;

  it("names a group the directory has not produced yet, and says so", () => {
    expect(groupRow({ groupName: "Contractors", groupUnconfirmed: true }).label).toBe("Contractors (group, not seen yet)");
  });

  it("drops the note once the group is confirmed", () => {
    expect(groupRow({ groupName: "Engineering" }).label).toBe("Engineering (group)");
  });

  it("still says 'unknown' when there is no name at all", () => {
    // the id resolves to nothing — a different fact, and a different next step for the reader
    expect(groupRow({}).label).toBe("unknown group (group)");
  });

  it("a caller that passes no note reads exactly as before", () => {
    const rows = buildGroupRoleRows([a("as1", "r1", "R", "group:abc#member", { groupName: "X", groupUnconfirmed: true })], "unknown group", "group");
    expect(rows[0]!.label).toBe("X (group)");
  });
});
