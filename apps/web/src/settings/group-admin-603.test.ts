// #603 / ADR-207: a group may hold the tenant tier, and the member table says what that means.
//
// Three claims, pinned pure (no DOM — the components execute what these functions decide, #536):
//   1. the admin-via-group marker walks the ROWS: any member carrying an admin-holding group gets
//      `adminVia`, and nobody gets it without one (rev3's acceptance, verbatim);
//   2. the mechanism, not the name, decides what counts: a CUSTOM role named "admin" on a group never
//      produces a marker;
//   3. the floor's 409 reaches the reader as a REASON — both locales carry the group-aware sentence,
//      and it differs from the ordinary last-admin sentence (the user's condition: a refusal that
//      reads as a bug is one the next person removes in good faith).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  adminGroupNames, buildUnifiedRows, groupRoleValue,
  type TenantAssignment, type RowMember, type GroupRoleRow,
} from "./tenant-role-rows";

const asg = (over: Partial<TenantAssignment>): TenantAssignment => ({
  id: "a1", roleId: null, roleName: "admin", principal: "group:abc#member", ...over,
});

describe("#603: the admin-via-group marker is mechanism-driven", () => {
  it("a custom role NAMED admin confers no marker; the built-in tier does", () => {
    const custom = asg({ id: "c1", roleId: "r9", roleName: "admin", groupName: "Pretenders" });
    const tier = asg({ id: "t1", builtin: "admin", groupName: "Ops" });
    expect([...adminGroupNames([custom])]).toEqual([]);
    expect([...adminGroupNames([custom, tier])]).toEqual(["Ops"]);
  });

  it("a user principal holding the marker's shape is not a group and does not count", () => {
    expect([...adminGroupNames([asg({ principal: "user:someone", builtin: "admin", groupName: "Ops" })])]).toEqual([]);
  });

  it("walks the rows: every member carrying an admin group is marked, and nobody else (rev3 acceptance)", () => {
    const members: RowMember[] = [
      { sub: "in-ops", display_name: "In Ops", email: null, role: "member", groups: ["Ops", "Docs"] },
      { sub: "row-admin", display_name: "Row Admin", email: null, role: "admin", groups: ["Docs"] },
      { sub: "both", display_name: "Both", email: null, role: "admin", groups: ["Ops"] },
      { sub: "outside", display_name: "Outside", email: null, role: "member", groups: null },
    ];
    const rows = buildUnifiedRows(members, [], new Set(), new Set(["Ops"]));
    const via = Object.fromEntries(rows.filter((r) => r.kind === "user").map((r) => [r.sub, r.adminVia]));
    expect(via["in-ops"], "carries Ops → marked, and the marker names the group").toEqual(["Ops"]);
    expect(via["both"], "their own row tier does not suppress what the group confers").toEqual(["Ops"]);
    expect(via["row-admin"], "admin by their own row, nothing conferred → no marker").toBeUndefined();
    expect(via["outside"], "no groups → no marker").toBeUndefined();
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
