// #582 bounce: the field that searches for a member says the same thing everywhere.
//
// The page permissions dialog asked for a "member id" long after #557 turned that field into a search
// by name — the control changed and the words stayed, so the screen told you to type something the
// input does not want. Meanwhile the space side said "Search members…" and the tenant side had its own
// copy of the same sentence. Three strings for one field is how one of them ends up wrong and nobody
// notices: the wrong one is only wrong in the screen you happen to open.
//
// So there is ONE key, and the pin is that every member-search field reads it. Not "the string is
// right" — a pin on the text passes the moment someone adds a fourth copy with the right words in it,
// and then rots the same way. What it cannot see: whether the key's value is good copy. That is what
// the reviewer reads.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOTS = ["settings", "ui"].map((d) => resolve(import.meta.dirname, "..", d));
const SHARED_KEY = "common.memberSearch";

/** Every `<MemberSearchInput …>` element in the app, with its props, as source text. */
function memberSearchElements(): { file: string; element: string }[] {
  const found: { file: string; element: string }[] = [];
  for (const root of ROOTS) {
    for (const file of readdirSync(root).filter((f) => f.endsWith(".tsx"))) {
      const src = readFileSync(resolve(root, file), "utf8");
      for (const m of src.matchAll(/<MemberSearchInput\b[\s\S]*?\/>/g)) {
        found.push({ file, element: m[0] });
      }
    }
  }
  return found;
}

describe("#582: one field, one sentence", () => {
  const elements = memberSearchElements();

  it("the scan finds the member-search fields (it is not passing on an empty list)", () => {
    expect(elements.length, "the permissions dialog and the shared grantee form both have one").toBeGreaterThanOrEqual(3);
  });

  for (const { file, element } of elements) {
    const line = element.split("\n")[0]!.trim();
    it(`${file}: ${line.slice(0, 40)}… reads the shared key`, () => {
      const placeholder = /placeholder=\{t\("([^"]+)"\)\}/.exec(element)?.[1];
      expect(placeholder, `${file}: a member search must show the shared copy, not its own`).toBe(SHARED_KEY);
    });
  }

  it("and the strings it replaced are gone from both locales (no second copy to drift)", () => {
    for (const loc of ["en", "ja"]) {
      const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${loc}.json`), "utf8"));
      expect(bundle.common?.memberSearch, `${loc}: the shared key exists`).toBeTruthy();
      expect(bundle.permissions?.memberPlaceholder, `${loc}: the "member id" copy is retired`).toBeUndefined();
      expect(bundle.permissions?.restrictPlaceholder, `${loc}: so is its twin on the restrict field`).toBeUndefined();
      expect(bundle.spaceMembers?.addPlaceholder, `${loc}: and the space side's own copy`).toBeUndefined();
    }
  });

  it("the shared copy describes a search, not an identifier", () => {
    // The narrow half of the ruling: the field takes a name and lists candidates. "member id" told
    // people to type the one thing it does not accept.
    for (const loc of ["en", "ja"]) {
      const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${loc}.json`), "utf8"));
      expect(bundle.common.memberSearch).not.toMatch(/\bid\b|ID/);
    }
  });
});
