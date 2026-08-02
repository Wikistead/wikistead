// The two copies of COMPOSITE_BUILTINS, compared.
//
// `editor` means edit + comment. ADR-199 §2 severed edit ⇒ comment in the model, so the noun has to
// grant both arms or "Engineering → editor" produces editors who cannot comment. The table that says
// so exists TWICE: once in the web dispatch (what the Members picker grants) and once in the server's
// roles route (what a group mapping confers). Both files carry a comment claiming the pair is pinned —
// the server's says "one table per side, same content, both pinned" — and no test compared them. This
// one does.
//
// It matters more than a tidy-up: the two sides answer the same question for DIFFERENT users. Drift
// would not fail a build or a route test; it would quietly make a group-mapped editor unable to
// comment while a picker-granted editor could, on the same space. That is the shape of #497's original
// bug, and the reason ADR-199 §2 rev5 wrote the rule down in the first place.
//
// The lock-step reads the SOURCE of both files rather than importing the server (the web package
// cannot import apps/server, and the roles route pulls in the whole app graph). Same technique as
// space-grant-roles-529.test.ts, which pins GRANTABLE against the same server file.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMPOSITE_BUILTINS } from "./grant-dispatch";

const SERVER_ROLES = resolve(import.meta.dirname, "../../../../apps/server/src/routes/roles.ts");

/** The server's table, parsed out of its declaration: `{ edit: ['edit', 'comment'] }`. */
function serverTable(): Record<string, string[]> {
  const src = readFileSync(SERVER_ROLES, "utf8");
  const m = /const COMPOSITE_BUILTINS: Record<string, string\[\]> = \{([^}]*)\}/.exec(src);
  expect(m, "the server still declares COMPOSITE_BUILTINS in the shape this pin reads").not.toBeNull();
  const out: Record<string, string[]> = {};
  for (const entry of m![1]!.matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)) {
    out[entry[1]!] = [...entry[2]!.matchAll(/['"]([^'"]+)['"]/g)].map((c) => c[1]!);
  }
  return out;
}

describe("the composite built-in bundle is the same on both sides", () => {
  it("the server file is readable and non-empty (guard against a vacuous pass)", () => {
    const table = serverTable();
    expect(Object.keys(table).length, "an empty parse would make every comparison below trivially true").toBeGreaterThan(0);
  });

  it("web and server agree, key for key", () => {
    const server = serverTable();
    expect(Object.keys(COMPOSITE_BUILTINS).sort(), "the same nouns are composite on both sides").toEqual(Object.keys(server).sort());
    for (const [noun, caps] of Object.entries(COMPOSITE_BUILTINS)) {
      expect(caps, `${noun} confers the same capabilities whether granted or mapped`).toEqual(server[noun]);
    }
  });

  it("editor still carries the comment arm (the rule the table exists for)", () => {
    // Named explicitly so the pin says WHY, not just "these two literals match". If ADR-199 §2 is ever
    // revisited, this is the assertion to argue with.
    expect(COMPOSITE_BUILTINS["edit"], "ADR-199 §2: severing edit ⇒ comment left the bare capability unable to comment").toEqual(["edit", "comment"]);
    expect(serverTable()["edit"]).toEqual(["edit", "comment"]);
  });
});
