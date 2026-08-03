// #536(user re-ruling): the Roles tab shows ONE roles list — built-in and custom, tenant- and
// resource-scope, side by side — and creation is one flow with no scope selector (scope derives from
// the checked capabilities; the two vocabularies are disjoint).
//
// Lexical, deliberately (the one-add-control-536 precedent): what is pinned is that a SECOND section
// or a scope pre-question does not come back. Behaviour (derivation, badges, the member toggle) is
// covered by the e2e specs (admin-roles-420 / roles-ia-469; the mapping spec went with the
// mechanism in #578 slice 7).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(import.meta.dirname, "./AdminRolesTab.tsx"), "utf8");

describe("#536one roles list, one creation flow", () => {
  it("has exactly one roles list container; the old per-section containers are gone", () => {
    expect(src.match(/data-testid="roles-list"/g)).toHaveLength(1);
    for (const dead of ['data-testid="builtin-tenant-roles"', 'data-testid="builtin-roles"', 'data-testid="custom-roles"']) {
      expect(src, `${dead} must stay deleted`).not.toContain(dead);
    }
  });

  // #580 SUPERSEDES the derivation this used to pin. Deriving the scope from the boxes did remove the
  // hidden <Select> — and left the user unable to tell which kind of role they were making until they
  // had ticked something. The rule that survives is the one that mattered: NO hidden scope control.
  // The choice is visible segments now, and a mixed role is unbuildable rather than refused at save,
  // so the mixed hint has nothing left to warn about.
  // #587 re-points the SHAPE, not the rule: the segments are the DS RadioGroup now, so the hand-rolled
  // buttons (and the literal `data-testid={`role-scope-${s}`}` this used to read) are gone. The rule
  // that survives is unchanged — the scope is chosen in the open, never through a Select. `testId` is
  // no longer evidence of a Select: it is how the DS names its options, so the assertion moved to the
  // element that would actually be the regression.
  it("creation asks for the scope in the open — segments, never a hidden Select", () => {
    expect(src).not.toMatch(/<Select[^>]*role-scope/); // the Select stays gone
    expect(src).toContain('data-testid="role-scope-segments"');
    expect(src, "the DS segmented radiogroup, not a hand-rolled one (#587)").toMatch(/variant="segmented"[\s\S]{0,400}testId="role-scope"/);
    // the two options are still the pair, and their ids are what the e2e spec drives
    expect(src).toMatch(/value: "resource"/);
    expect(src).toMatch(/value: "tenant"/);
    // the capability list follows the segment — that is what makes a mix impossible to compose
    expect(src).toMatch(/const list = scope === "tenant" \? TENANT_CAPABILITIES : CAPABILITIES/);
    expect(src).toContain('list={list}');
    // …so the mixed-state machinery is gone with it
    expect(src, "nothing left to warn about").not.toContain('data-testid="role-mixed-hint"');
    expect(src).not.toMatch(/\|\| mixed\}/);
  });

  // #581 SUPERSEDES the scope badge on THIS list.put it on every row because the sections it
  // sat in did not read as sections; #581 fixed the sections, and repeating what position already says
  // is the redundancy the user asked us to drop. The component keeps the ability (a list that MIXES
  // scopes still needs it) — this pins that the list stops using it, and that BUILT-IN stays, because
  // no position implies that one.
  it("rows say BUILT-IN but not their scope — the section they sit in says that", () => {
    expect(src).toContain('data-testid="role-builtin-badge"');
    expect(src).toContain('<RoleBadges builtIn />');
    expect(src, "no call in this file passes a scope any more").not.toMatch(/<RoleBadges[^>]*scope=/);
    // the capability itself survives for surfaces that mix scopes
    expect(src).toMatch(/scope\?: "resource" \| "tenant"/);
  });

  // #581: the sections are surfaces with a boundary, and each is bounded in height like every other
  // growing list in settings (#503 / #521 / #539 — this is the fourth).
  it("each scope section is a card with its own bounded, scrollable list", () => {
    for (const id of ["roles-list-tenant", "roles-list-resource"]) {
      const at = src.indexOf(`data-testid="${id}"`);
      expect(at, `${id} exists`).toBeGreaterThan(-1);
      const opening = src.lastIndexOf("<div", at);
      const box = src.slice(opening, at);
      expect(box, `${id} is the 26rem box`).toContain("max-h-[26rem]");
      expect(box).toContain("overflow-y-auto");
    }
    expect(src.match(/<section className="rounded-md border border-border bg-panel">/g) ?? []).toHaveLength(2);
  });

  // #536④: the ONE set is presented in TWO scope sections — tenant above, space/page below,
  // each built-in → custom (the re-ruling keeps "one set", changes the dividing axis to SCOPE).
  it("④: scope sections — tenant precedes space/page; each orders built-in → custom (DOM-pinned)", () => {
    const tenantHdr = src.indexOf('data-testid="roles-section-tenant"');
    const resourceHdr = src.indexOf('data-testid="roles-section-resource"');
    expect(tenantHdr, "tenant section exists").toBeGreaterThan(-1);
    expect(resourceHdr, "resource section exists").toBeGreaterThan(-1);
    expect(tenantHdr, "tenant section comes first").toBeLessThan(resourceHdr);
    // tenant section: built-ins (member/admin) precede its custom rows
    const tenantSeg = src.slice(tenantHdr, resourceHdr);
    expect(tenantSeg.indexOf('data-testid="builtin-role-member"')).toBeGreaterThan(-1);
    expect(tenantSeg.indexOf('data-testid="builtin-role-member"')).toBeLessThan(tenantSeg.indexOf('scope === "tenant"'));
    // resource section: built-in resource roles precede its custom rows
    const resourceSeg = src.slice(resourceHdr);
    expect(resourceSeg.indexOf("roles.data?.builtIn")).toBeGreaterThan(-1);
    expect(resourceSeg.indexOf("roles.data?.builtIn")).toBeLessThan(resourceSeg.indexOf('scope !== "tenant"'));
  });

  // RETIRED by #578 / ADR-201 rev3 slice 5: the tenant default role is gone, so its "no selection"
  // label has nothing left to label. The rule that survived the case — a built-in role name is a proper
  // noun, undecorated and untranslated — is #582's, and it is pinned where the names are actually
  // rendered (tenant-role-rows-579.test.ts and comment-panel-vocabulary-582.test.ts). Removed rather
  // than left asserting a key that no locale carries.
  it("a built-in cannot be edited, and at rest no role shows a grid at all", () => {
    // RE-AIMED by #586②: the read-only grids left the list — a role at rest is its NAME, and the
    // name's hover window says what it confers. What this keeps pinning is the half that must not move:
    // nothing offers an EDITING grid for a built-in (the member row's control edits the tenant DEFAULTS,
    // a different thing, and stays), and the custom rows' grid appears only behind its edit affordance.
    expect(src, "no editable grid for the resource built-ins").not.toMatch(/idPrefix=\{`builtin-\$\{r\.name\}`\}/);
    expect(src, "no grid at all for the admin tier").not.toMatch(/idPrefix="builtin-admin"/);
    expect(src, "the custom grid is behind the edit affordance").toMatch(/capsOpenId === r\.id && \(/);
    expect(src, "the member DEFAULTS control stays editable").toMatch(/idPrefix="builtin-member"/);
  });
});
