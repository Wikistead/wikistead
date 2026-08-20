// #603 / ADR-207: a group may hold the tenant tier, and the member table says what that means.
//
// Three claims, pinned pure (no DOM — the components execute what these functions decide, #536):
//   1. the via-group marker walks the ROWS: any member carrying a role-holding group gets a badge, and
//      nobody gets one without. RE-AIMED (review rejection 2026-08-05): it used to say "admin-holding",
//      because only admin produced a marker — a group conferring a CUSTOM tenant role left its members
//      holding the capability with nothing on screen saying where it came from. The subject is now every
//      role a group confers, which is what "roles are one framework" has meant everywhere else;
//   2. the mechanism, not the name, decides what a BUILT-IN is: a CUSTOM role named "admin" on a group
//      is reported as the custom role it is, never as the tier;
//   3. the floor's 409 reaches the reader as a REASON — both locales carry the group-aware sentence,
//      and it differs from the ordinary last-admin sentence (the user's condition: a refusal that
//      reads as a bug is one the next person removes in good faith).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  groupConferredRoles, buildUnifiedRows, groupRoleValue,
  type TenantAssignment, type RowMember, type GroupRoleRow,
} from "./tenant-role-rows";

const asg = (over: Partial<TenantAssignment>): TenantAssignment => ({
  id: "a1", roleId: null, roleName: "admin", principal: "group:abc#member", ...over,
});

describe("#603: what a group confers is reported by mechanism, for every role", () => {
  it("a custom role NAMED admin is reported as that custom role; the built-in tier as the tier", () => {
    const custom = asg({ id: "c1", roleId: "r9", roleName: "admin", groupName: "Pretenders" });
    const tier = asg({ id: "t1", builtin: "admin", groupName: "Ops" });
    expect(groupConferredRoles([custom])).toEqual([{ role: "admin", group: "Pretenders" }]);
    expect(groupConferredRoles([custom, tier])[1]).toEqual({ role: "admin", group: "Ops", builtin: "admin" });
  });

  it("a CUSTOM tenant role on a group is reported too — the case the reject found", () => {
    const custom = asg({ id: "c2", roleId: "r-bbb", roleName: "bbb", groupName: "Writers" });
    expect(groupConferredRoles([custom]), "not only admin").toEqual([{ role: "bbb", group: "Writers" }]);
    // with the definitions to hand, the badge can raise the same capability panel a picker option does
    expect(groupConferredRoles([custom], [{ id: "r-bbb", name: "bbb", scope: "tenant", capabilities: ["createSpaces"] }]))
      .toEqual([{ role: "bbb", group: "Writers", capabilities: ["createSpaces"] }]);
  });

  it("a user principal holding the marker's shape is not a group and does not count", () => {
    expect(groupConferredRoles([asg({ principal: "user:someone", builtin: "admin", groupName: "Ops" })])).toEqual([]);
  });

  it("walks the rows: one badge per (role, group) a member's groups confer, and none otherwise", () => {
    const members: RowMember[] = [
      { sub: "in-ops", display_name: "In Ops", email: null, role: "member", groups: ["Ops", "Docs"] },
      { sub: "row-admin", display_name: "Row Admin", email: null, role: "admin", groups: [] },
      { sub: "both", display_name: "Both", email: null, role: "admin", groups: ["Ops"] },
      { sub: "outside", display_name: "Outside", email: null, role: "member", groups: null },
    ];
    const conferred = groupConferredRoles([
      asg({ id: "t1", builtin: "admin", groupName: "Ops" }),
      asg({ id: "c3", roleId: "r-doc", roleName: "docs-writer", groupName: "Docs" }),
    ]);
    const rows = buildUnifiedRows(members, [], new Set(), conferred);
    const via = Object.fromEntries(rows.filter((r) => r.kind === "user").map((r) => [r.sub, r.groupRoles]));
    expect(via["in-ops"], "two groups, two roles → two badges, not one with a comma").toEqual([
      { role: "admin", group: "Ops", builtin: "admin" },
      { role: "docs-writer", group: "Docs" },
    ]);
    expect(via["both"], "their own row tier does not suppress what the group confers")
      .toEqual([{ role: "admin", group: "Ops", builtin: "admin" }]);
    expect(via["row-admin"], "admin by their own row, nothing conferred → no badge").toBeUndefined();
    expect(via["outside"], "no groups → no badge").toBeUndefined();
  });
});

describe("#603: the group row's control reads the mechanism-prefixed vocabulary", () => {
  const row = (held: GroupRoleRow["held"]): GroupRoleRow => ({ principal: "group:abc#member", label: "Ops (group)", held });
  it("a tier shows as tier:<name>, a custom role as role:<id>, nothing as the placeholder", () => {
    expect(groupRoleValue(row([{ assignmentId: "a", roleId: null, roleName: "admin", builtin: "admin", managed: false }]))).toBe("tier:admin");
    expect(groupRoleValue(row([{ assignmentId: "a", roleId: "r9", roleName: "admin", managed: false }]))).toBe("role:r9");
    expect(groupRoleValue(row([]))).toBe("");
    expect(groupRoleValue(undefined)).toBe("");
  });
});

describe("#603: the floor's 409 carries its reason to the reader", () => {
  it("both locales have BOTH sentences, and they differ (the branch is real)", () => {
    for (const loc of ["en", "ja"]) {
      const j = JSON.parse(readFileSync(resolve(import.meta.dirname, `../i18n/locales/${loc}.json`), "utf8"));
      const plain = j.members.lastAdmin as string;
      const floor = j.members.lastDirectAdmin as string;
      expect(plain, `${loc}: the ordinary refusal exists`).toBeTruthy();
      expect(floor, `${loc}: the group-aware refusal exists`).toBeTruthy();
      expect(floor, `${loc}: two refusals, two reasons — never one string`).not.toBe(plain);
      expect(floor, `${loc}: the reason names the IdP risk`).toMatch(/IdP/);
    }
  });

  it("the members screen maps the server's code, not the status alone", () => {
    const src = readFileSync(resolve(import.meta.dirname, "./MembersPage.tsx"), "utf8");
    expect(src, "the code decides the sentence").toContain('e.code === "last_direct_admin"');
    expect(src, "the ordinary 409 keeps its own words").toContain('t("members.lastAdmin")');
    expect(src, "no hard-coded English refusal survives").not.toContain('"Cannot change the last admin."');
  });
});

// Discovery-shaped, per the reject's last condition (no admin-only name such as `adminVia`): the
// screen must not grow a second, tier-specific path back. A name that singles out one role is how the
// gap was built in the first place — the badge only ever looked at admin because the data it read was
// called `adminVia` and computed by `adminGroupNames`.
describe("#603: no admin-only path grows back", () => {
  const files = ["tenant-role-rows.ts", "MembersPage.tsx", "GroupRolesMark.tsx"];
  for (const f of files) {
    it(`${f} carries no admin-specific via vocabulary`, () => {
      const src = readFileSync(resolve(import.meta.dirname, f), "utf8");
      for (const banned of ["adminVia", "adminGroupNames", "admin-via-group"]) {
        expect(src, `${f}: ${banned} names one role where the rule is about all of them`).not.toContain(banned);
      }
    });
  }

  // EVERY conferred role reaches the screen. The shape that carries them changed — the per-role badge is
  // retracted (ruling) and the mark's hover list carries them now — but the failure this guards is
  // the same one, and it is the one that actually happened: the first version read `groupRoles[0]` and
  // joined the group names, so a second conferred role had nowhere to go.
  it("every conferred role reaches the list, iterated rather than indexed or joined", () => {
    const mark = readFileSync(resolve(import.meta.dirname, "GroupRolesMark.tsx"), "utf8");
    expect(mark, "iterated, not indexed at [0]").toMatch(/roles\.map\(/);
    expect(mark, "not folded into one line of joined names").not.toMatch(/roles[\s\S]{0,80}\.join\(/);
    expect(mark, "the count is the list's own length, so it cannot disagree with it").toMatch(/roles\.length/);

    const page = readFileSync(resolve(import.meta.dirname, "MembersPage.tsx"), "utf8");
    expect(page, "the row hands the whole field over").toMatch(/<GroupRolesMark roles=\{row\.groupRoles \?\? \[\]\}/);
    expect(page, "and keeps none of the retracted per-role badge").not.toContain("role-via-group");
  });
});
