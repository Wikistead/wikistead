// #586 (review rejection, 2026-08-04): a switch that cannot be saved must not be drawn.
//
// The tenant's member policy was rendered with the CUSTOM TENANT ROLE vocabulary — five capabilities —
// while its handler sent two. The other three were enabled, clickable, and answered with "saved". An
// authorization surface reported success and changed nothing, which is #596's defect on the screen that
// configures authorization. (The row it lived in was wrong too: a built-in role has no editing surface.
// That half is measured in the browser by roles-ia-469; this is the part that can be decided from the
// source, and is the part that would come back silently.)
//
// The pin is a RULE, not a list of capability names: whatever the policy's picker offers must be a
// subset of what its handler sends. A sixth default added later is covered without editing this file.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(import.meta.dirname, "./AdminRolesTab.tsx"), "utf8");

/** The `list={…}` a picker is handed, resolved through a `const NAME = [...] as const` if it names one. */
function offeredBy(block: string): string[] {
  const listProp = /list=\{([A-Za-z_$][\w$]*)\}/.exec(block);
  if (listProp) {
    const decl = new RegExp(`const ${listProp[1]}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
    if (!decl) throw new Error(`the picker names a list this file does not declare: ${listProp[1]}`);
    return [...decl[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  }
  const inline = /list=\{\[([^\]]*)\]\}/.exec(block);
  if (!inline) throw new Error("the picker was found but its list was not");
  return [...inline[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("#586: every switch on the member-defaults picker reaches the endpoint", () => {
  // the section, from its testid to the end of the picker's onChange
  const section = (() => {
    const start = src.indexOf('data-testid="member-defaults"');
    expect(start, "the tenant defaults have their own section").toBeGreaterThan(-1);
    const end = src.indexOf("</section>", start);
    return src.slice(start, end);
  })();

  it("the picker offers only capabilities the mutation carries", () => {
    const offered = offeredBy(section);
    expect(offered.length, "the section draws switches at all").toBeGreaterThan(0);
    // what the handler actually READS out of the picked set — `caps.includes("x")` is how each switch
    // becomes a field on the request body
    const sent = [...section.matchAll(/caps\.includes\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(sent.length, "the handler sends something").toBeGreaterThan(0);
    const unsendable = offered.filter((c) => !sent.includes(c));
    expect(unsendable, "a switch with nowhere to go: clicking it would report success and save nothing").toEqual([]);
  });

  it("…and the endpoint's payload has a field for each of them", () => {
    // the second half of the same claim, from the other side: the mutation's own type. A capability the
    // handler mentions but the request cannot carry would be the same lie one layer down.
    const queries = readFileSync(resolve(import.meta.dirname, "../data/queries.ts"), "utf8");
    const patch = /mutationFn: \(patch: \{([^}]*)\}\)/.exec(queries.slice(queries.indexOf("useSetTenantRoleDefaults")));
    expect(patch, "the defaults mutation declares its payload").not.toBeNull();
    const fields = [...patch![1]!.matchAll(/(\w+)\??:/g)].map((m) => m[1]!.toLowerCase());
    for (const cap of offeredBy(section)) {
      expect(fields.some((f) => f.includes(cap.toLowerCase())), `no field carries ${cap}`).toBe(true);
    }
  });
});

describe("#586: a built-in role row has no editing surface", () => {
  it("neither tier row renders a picker — the freedom is what a custom role is for", () => {
    for (const row of ["member", "admin"]) {
      const start = src.indexOf(`data-testid="builtin-role-${row}"`);
      expect(start, `the ${row} row exists`).toBeGreaterThan(-1);
      // the row's own block: up to the next sibling div at the same nesting, approximated by the next
      // `data-testid="builtin-role-` or the section's end
      const rest = src.slice(start + 1);
      const nextRow = rest.indexOf('data-testid="builtin-role-');
      const nextSection = rest.indexOf("</section>");
      const end = Math.min(...[nextRow, nextSection].filter((i) => i > -1));
      const block = rest.slice(0, end);
      expect(block, `the ${row} row draws a capability picker`).not.toMatch(/<CapabilityPicker/);
      expect(block, `the ${row} row says what it confers by name`).toMatch(/<RoleTip/);
    }
  });
});
