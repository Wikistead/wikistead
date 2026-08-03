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
  // RE-AIMED by #579 ① (2026-08-03): the tenant screen no longer has a group SECTION — groups are rows
  // in the member table, and a group nobody carries yet is named from the table's own search, which is
  // "). So the tenant half of every assertion below points at the member table now. The
  // subject is unchanged: there is ONE implementation of "name a group", and neither screen grows a
  // second one.
  const tenant = read("./MembersPage.tsx");

  it("both screens reach the shared component", () => {
    // bounce ③ moved the picker one level down: both screens now render the shared ADD FORM, and the
    // form renders the one group control. The invariant is unchanged — there is a single
    // implementation of "name a group" — so the pin follows it rather than pretending the old shape.
    const form = read("./GranteeRoleForm.tsx");
    expect(form, "the shared form owns the group control").toMatch(/<GroupPicker\b/);
    expect(space, "space Members tab").toMatch(/<GranteeRoleForm\b/);
    // the tenant screen names a group through its search instead of a form: a typed name that matches
    // no existing row offers itself as one, which is the same capability reached from the same box a
    // reader is already typing in
    expect(tenant, "tenant member table").toMatch(/member-row-new-group/);
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
    expect(picker, "the marker appears only for a name the directory has not produced").toMatch(/!isKnown/);
  });

  // #578 bounce ②: " UI UI UI ". The stacked
  // Select is gone; what is left is one input that completes, the same shape the person picker beside
  // it already had. A pin on the ABSENCE, because a second control creeping back is exactly how these
  // two halves drifted apart the first time.
  it("it is ONE input with completion, not a Select stacked on an Input", () => {
    expect(picker, "no Select in the group control").not.toMatch(/<Select\b/);
    expect(picker, "completion is offered as a list").toMatch(/data-testid=\{`\$\{testId\}-list`\}/);
    expect(picker).toMatch(/data-testid=\{`\$\{testId\}-item`\}/);
  });

  it("#579's asymmetry is untouched — only the GROUP half is shared", () => {
    // the tier picker (exclusive) and the custom-role chips (additive) stay as #579 built them
    const rows = read("./tenant-role-rows.ts");
    expect(rows).toMatch(/BUILT_IN_TIERS/);
    expect(read("./MembersPage.tsx"), "the member row still has ONE picker offering tiers and custom roles").toMatch(/resolveRoleChoice/);
  });
});

// UI ". The FLOW is now one component — grantee type, then who, then which
// role — and each screen differs only in the arguments it passes.
//
// One difference is deliberate and is pinned as such: the tenant screen offers groups only, because
// #579 ruled that a person's tenant role is given on their own row and nowhere else (its e2e asserts
// there is no second assign form). Offering a person here would reverse that ruling, so it is raised
// on the ticket rather than decided in a component.
describe("#578 ③: both screens run the same add-flow", () => {
  const form = read("./GranteeRoleForm.tsx");
  const space = read("./SpaceMembersTab.tsx");
  // RE-AIMED by #579 ① (2026-08-03): the tenant screen no longer has a group SECTION — groups are rows
  // in the member table, and a group nobody carries yet is named from the table's own search, which is
  // "). So the tenant half of every assertion below points at the member table now. The
  // subject is unchanged: there is ONE implementation of "name a group", and neither screen grows a
  // second one.
  const tenant = read("./MembersPage.tsx");

  it("the space screen renders the shared form, and the tenant screen names a group from its search", () => {
    // Two shapes on purpose now, and the ruling is why: the tenant screen has no add-flow at all
    // people get their role on their row and a group that is not yet a row is named in the search box.
    // Pinning "both render the form" would now be pinning a form the ruling removed.
    expect(space).toMatch(/<GranteeRoleForm\b/);
    expect(tenant).toMatch(/member-row-new-group/);
  });

  it("neither screen keeps its own copy of the row", () => {
    // the shape that was there before: a hand-built FormRow with the type Select, the picker and Add
    expect(space, "space still builds the add row itself").not.toMatch(/testId="space-grant-type"/);
    expect(tenant, "tenant still builds the add row itself").not.toMatch(/data-testid="tenant-group-assign-add"/);
  });

  it("the form takes the grantee kinds as an argument, and hides the control when there is one", () => {
    expect(form).toMatch(/types\.length > 1/);
    expect(space, "the space screen offers both").toMatch(/types=\{\["user", "group"\]\}/);
    // the tenant screen no longer offers a KIND at all: its table already holds both, and a group is
    // named by typing it (#579 ①). Nothing there should be constructing a grantee-type control.
    expect(tenant, "the tenant screen has no grantee-type control left").not.toMatch(/types=\{/);
  });

  it("it owns no state and knows no endpoint — the caller decides what add means", () => {
    expect(form, "no fetching in the shared form").not.toMatch(/useMutation|fetch\(|useQuery/);
    expect(form).toMatch(/onAdd: \(\) => void/);
  });
});
