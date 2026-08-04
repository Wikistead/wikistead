// #582 bounce (user, on the device): "KAKUNIN-582 manager
//
// The page permissions dialog had taken half of the space screen's shape (custom roles in the picker)
// and left the other half behind, so one panel said three things about the same idea: the picker
// offered (a translated verb), the grant rows printed "manage" (the raw wire value, as loose
// text), and a tenant's own role came back as "KAKUNIN-582" (uppercased, i.e. renamed).
//
// The ruling that settles it: a ROLE NAME is a proper noun — never translated, never case-shifted
// and a CAPABILITY is translated on the surface that edits a role definition, where it describes what
// the role may do. So an access list speaks role names, on both screens.
//
// The pins compare the two screens against ONE table rather than against copies of it: a hand-written
// second list is exactly how this vocabulary drifted apart, and #553's GRANTABLE is the fix that held.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CAP_NOUN, capNoun } from "./role-nouns";

const read = (rel: string) => readFileSync(resolve(import.meta.dirname, rel), "utf8");

describe("#582: one role vocabulary, shared by both surfaces", () => {
  it("the nouns live in one module that both screens import", () => {
    expect(read("./SpaceMembersTab.tsx"), "space Members tab").toMatch(/from "\.\/role-nouns"/);
    expect(read("../ui/PermissionsDialog.tsx"), "page permissions dialog").toMatch(/from "\.\.\/settings\/role-nouns"/);
  });

  it("neither screen keeps its own copy of the table", () => {
    for (const [name, rel] of [["space", "./SpaceMembersTab.tsx"], ["page dialog", "../ui/PermissionsDialog.tsx"]] as const) {
      expect(read(rel), `${name} re-declares the nouns`).not.toMatch(/view:\s*"viewer"/);
    }
  });

  it("every capability has a noun, and unknown values pass through", () => {
    // #607 / ADR-209: `manageAccess` → `access-manager`; #604 C: delete/share/settings → the leaf names
    expect(Object.keys(CAP_NOUN).sort()).toEqual(["comment", "delete", "edit", "manage", "manageAccess", "moderate", "settings", "share", "view"].sort());
    expect(capNoun("manage")).toBe("manager");
    expect(capNoun("kakunin-582"), "a role name is already a name").toBe("kakunin-582");
  });
});

describe("#582: the page dialog says role names, in one shape", () => {
  const dialog = read("../ui/PermissionsDialog.tsx");

  it("the picker offers nouns, not translated verbs", () => {
    expect(dialog, "the built-in options run through the shared table").toMatch(/label: capNoun\(c\)/);
    // the shape that was there: five hand-listed options labelled with the capability translation
    expect(dialog, "no per-capability translation in the picker").not.toMatch(/label: t\("permissions\.(view|edit|manage|moderate)"\)/);
  });

  it("a built-in row wears the same badge as a role row, with the same noun", () => {
    const badges = dialog.match(/data-testid="grant-role-badge"/g) ?? [];
    expect(badges, "both row kinds use the one badge").toHaveLength(2);
    expect(dialog, "and the built-in badge is a noun, not the wire value").toMatch(/grant-role-badge">\{capNoun\(g\.relation\)\}/);
  });

  it("no badge shouts a role name back at its author", () => {
    // `uppercase` turned kakunin-582 into KAKUNIN-582 — a display that changes the name is still
    // changing the name, which the same ruling forbids.
    const badgeLines = dialog.split("\n").filter((l) => l.includes("grant-role-badge"));
    expect(badgeLines).toHaveLength(2);
    for (const l of badgeLines) expect(l, `uppercase on: ${l.trim().slice(0, 60)}`).not.toMatch(/\buppercase\b/);
  });

  it("the picker and the rows cannot drift apart", () => {
    // both go through capNoun, so a change to the table moves them together — which is the property
    // that failed here (the picker was translated and the row was raw, and each looked fine alone)
    const uses = dialog.match(/capNoun\(/g) ?? [];
    expect(uses.length, "picker and row both resolve through the table").toBeGreaterThanOrEqual(2);
  });
});
