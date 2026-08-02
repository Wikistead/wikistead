// #578 / ADR-201 rev3 slice 6: one control for naming a group, on both screens.
//
// The space Members tab and the tenant Roles tab both confer a role on an IdP group, and OQ4 gave that
// control two halves — pick a group the directory produced, or type one nobody carries yet. Two copies
// would drift, and the drift would read as "the tenant screen lets me declare a group and the space
// screen does not", which is the exact class of difference this ticket exists to remove. ADR-201's OQ6
// said to share the group half and leave #579's deliberate asymmetry (a tier is an exclusive Select,
// custom roles are additive chips) alone — so this pins the sharing, and nothing else.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(import.meta.dirname, rel), "utf8");

describe("#578: the group name control has one implementation", () => {
  const picker = read("./GroupPicker.tsx");
  const space = read("./SpaceMembersTab.tsx");
  const tenant = read("./TenantGroupRoles.tsx");

  it("both screens render the shared component", () => {
    expect(space, "space Members tab").toMatch(/<GroupPicker\b/);
    expect(tenant, "tenant Roles tab").toMatch(/<GroupPicker\b/);
  });

  it("neither screen keeps a hand-rolled group Select beside it", () => {
    // the shape that was there before: a Select whose options are the group list
    for (const [name, src] of [["space", space], ["tenant", tenant]] as const) {
      expect(src, `${name} still builds its own group options`).not.toMatch(/testId="[^"]*group"[\s\S]{0,200}groups\.data/);
    }
  });

  it("the typed half exists, and says when a name is unconfirmed", () => {
    // this is the half the retired mapping form had and a picker alone did not
    expect(picker).toMatch(/data-testid=\{`\$\{testId\}-name`\}/);
    expect(picker).toMatch(/data-testid=\{`\$\{testId\}-unconfirmed`\}/);
    expect(picker, "the marker appears only for a name the directory has not produced").toMatch(/value && !isKnown/);
  });

  it("a typed name does not make the Select look like it selected something", () => {
    expect(picker).toMatch(/value=\{isKnown \? value : ""\}/);
  });

  it("#579's asymmetry is untouched — only the GROUP half is shared", () => {
    // the tier picker (exclusive) and the custom-role chips (additive) stay as #579 built them
    const rows = read("./tenant-role-rows.ts");
    expect(rows).toMatch(/BUILT_IN_TIERS/);
    expect(read("./MembersPage.tsx"), "the member row still has ONE picker offering tiers and custom roles").toMatch(/resolveRoleChoice/);
  });
});
