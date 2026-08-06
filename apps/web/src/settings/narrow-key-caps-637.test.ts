// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #637 / ADR-216: the picker offers exactly the verbs the EE route table opens.
//
// Two lists of the same thing is how one of them goes stale. The server validates a requested capability
// against the table and refuses anything it does not offer, so a picker holding its own list can only
// drift in two directions: offering a verb that reaches nothing (the key silently does less than the
// person thought), or omitting one that works (a capability nobody can pick).
//
// The table lives in EE and the picker in CE, which is why this compares TEXT rather than importing it —
// the CE→EE boundary guard forbids the import, and rightly: #178 lifts that package out of the tree.
describe("#637: the narrowing picker and the EE route table offer the same verbs", () => {
  const read = (p: string) => readFileSync(resolve(import.meta.dirname, p), "utf8");

  it("every verb the table opens is offerable, and nothing else is", () => {
    const table = read("../../../../packages/ee-server/src/api-keys/narrowing.ts");
    // the rules are `['METHOD /path', ['view', 'edit']]` — collect the second element of each
    const offered = new Set<string>();
    for (const m of table.matchAll(/\[\s*'[A-Z]+ [^']*',\s*\[([^\]]*)\]/g)) {
      for (const c of m[1]!.matchAll(/'([a-z]+)'/g)) offered.add(c[1]!);
    }
    expect(offered.size, "the table was parsed (a broken pattern must not pass vacuously)").toBeGreaterThan(3);

    const picker = read("./ApiKeysPanel.tsx");
    const listed = /const NARROW_CAPS = \[([^\]]*)\]/.exec(picker)?.[1] ?? "";
    const picked = new Set([...listed.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!));
    expect(picked.size, "the picker's list was found").toBeGreaterThan(3);

    expect([...offered].filter((c) => !picked.has(c)), "the table opens these and the picker hides them").toEqual([]);
    expect([...picked].filter((c) => !offered.has(c)), "the picker offers these and they reach nothing").toEqual([]);
  });
});
