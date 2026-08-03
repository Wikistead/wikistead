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
// RE-AIMED by #578 bounce ③. The rule was "every member search reads THIS key", and it caught what it
// was built for (three screen-local copies of one sentence). It is now two keys, because there are two
// honest contexts: a field that takes a member (the page permissions dialog) and the shared grantee
// form, where the same control sits beside a type switch that also accepts a GROUP — telling a reader
// there that they may only search members is what made them conclude groups were impossible.
//
// The subject is unchanged: no screen writes its own. Both keys live in `common`, and the assertion is
// that the placeholder comes from there — a fourth screen-local copy still fails.
const SHARED_KEYS = ["common.memberSearch", "common.granteeSearch"];

/** Every `<MemberSearchInput …>` element in the app, with its props and its file's source. */
function memberSearchElements(): { file: string; element: string; src: string }[] {
  const found: { file: string; element: string; src: string }[] = [];
  for (const root of ROOTS) {
    for (const file of readdirSync(root).filter((f) => f.endsWith(".tsx"))) {
      const src = readFileSync(resolve(root, file), "utf8");
      for (const m of src.matchAll(/<MemberSearchInput\b[\s\S]*?\/>/g)) {
        found.push({ file, element: m[0], src });
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

  for (const { file, element, src } of elements) {
    const line = element.split("\n")[0]!.trim();
    it(`${file}: ${line.slice(0, 40)}… reads the shared key`, () => {
      const arg = /placeholder=\{t\(([^)]+)\)\}/.exec(element)?.[1]?.trim();
      expect(arg, `${file}: the placeholder must come from a translation key`).toBeTruthy();
      if (arg!.startsWith('"')) {
        expect(SHARED_KEYS, `${file}: a member search must show shared copy, not its own`).toContain(arg!.slice(1, -1));
        return;
      }
      // #578 (the bounce's correction): a surface that asks WHO first — a grantee TYPE control beside
      // the field — has already answered "member or group", so its field must say "members". Without
      // that control both arrive in this one field and it must say so. That is a rule about the
      // control's own shape, and it is pinned as one: the variable may only ever resolve to the two
      // shared keys, and it must be chosen by the type control's presence rather than by screen name.
      const decl = new RegExp(`const ${arg}\\s*=([^;]+);`).exec(src)?.[1] ?? "";
      expect(decl, `${file}: ${arg} is not derived in this file`).toBeTruthy();
      const keys = (decl.match(/"[^"]+"/g) ?? []).map((k) => k.slice(1, -1));
      expect(keys.length, `${file}: the choice is between the two shared keys, nothing else`).toBe(2);
      for (const k of keys) expect(SHARED_KEYS, `${file}: ${k} is not shared copy`).toContain(k);
      expect(decl, `${file}: the rule must read the control's shape, not a screen name`).toMatch(/types\.length/);
    });
  }

  it("and the strings it replaced are gone from both locales (no second copy to drift)", () => {
    for (const loc of ["en", "ja"]) {
      const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${loc}.json`), "utf8"));
      expect(bundle.common?.memberSearch, `${loc}: the shared key exists`).toBeTruthy();
      expect(bundle.common?.granteeSearch, `${loc}: and the grantee one, which names groups too`).toBeTruthy();
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
