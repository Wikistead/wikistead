// #1163 review B1 (review finding, fixed): `t("members.identitiesUnlinkLastWayIn")` was
// called with NO interpolation object, even though the key's value carries `{{name}}` in all 12
// locales — i18next's default `skipOnVariables: true` leaves an unresolved placeholder LITERALLY on
// screen rather than blanking it, and no rendered-component test in this repo would have caught it
// (MemberIdentityLinksSection has none; the web suite's 2338 tests never mount it). This is a source
// pin instead, following this directory's own convention (space-grant-roles-529.test.ts,
// factor-copy-follows-kinds-686.test.ts) of reading the .tsx source rather than rendering it — cheap,
// and it fails the moment a `t()` call site and its key's placeholders drift apart again.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import en from "../i18n/locales/en.json";

const SRC = readFileSync(fileURLToPath(new URL("./MemberIdentityLinksSection.tsx", import.meta.url)), "utf8");

/** Every `{{token}}` placeholder a locale value carries, e.g. "Unlink {{name}}'s..." -> ["name"]. */
const placeholdersOf = (value: string): string[] => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);

/** The options-object keys a `t("members.<key>", { ... })` call site actually passes, read from source. */
function optionKeysAtCallSite(key: string): string[] {
  const re = new RegExp(`t\\("members\\.${key}"(?:,\\s*\\{([^}]*)\\})?\\)`);
  const m = SRC.match(re);
  if (!m) throw new Error(`no t("members.${key}", ...) call site found in MemberIdentityLinksSection.tsx — re-aim this pin rather than deleting it`);
  if (!m[1]) return []; // called with no options object at all
  // option shorthand (`{ name }`) and `key: value` forms both resolve to the OPTION key, not the value
  return [...m[1].matchAll(/(\w+)(?:\s*:\s*[^,]+)?/g)].map((mm) => mm[1]!);
}

describe("#1163: every members.identitiesUnlink* call site passes what its key's placeholders need", () => {
  it.each(["identitiesUnlinkConfirm", "identitiesUnlinkLastWayIn", "identitiesUnlinkSelfRefused", "identitiesUnlinkDone", "identitiesUnlinkFailed"])(
    "%s: the call site's options cover every {{placeholder}} the en.json value carries",
    (key) => {
      const needed = placeholdersOf((en.members as unknown as Record<string, string>)[key]!);
      const passed = optionKeysAtCallSite(key);
      for (const p of needed) {
        expect(passed, `t("members.${key}") is missing the "${p}" option this key's value interpolates`).toContain(p);
      }
    },
  );
});
