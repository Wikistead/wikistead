// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #637 / ADR-216, rewritten for #667 / ADR-221: the picker offers exactly what the EE side declares.
//
// Two lists of the same thing is how one of them goes stale. The server validates every requested cell
// against its own declaration and refuses anything else, so a picker holding its own copy can drift in
// two directions: offering something that reaches nothing (the key silently does less than the person
// thought), or omitting something that works (a permission nobody can pick).
//
// WHAT CHANGED. The property was originally about the six borrowed VERBS and the v1 route table. Both
// still exist — a v1 key is evaluated by that table forever (ADR-221 §3) — but nothing offers those
// verbs any more: the form now offers resource types, so the old comparison has no picker to compare
// against and asserting it would measure two frozen constants agreeing with each other. The property is
// carried over to the pair that CAN drift, and the v1 table's own freeze is pinned in
// `v1-frozen-667.test.ts` against a literal copy, which is a stronger statement than this one was.
//
// The declaration lives in EE and the picker in CE, which is why this compares TEXT rather than
// importing it — the CE→EE boundary guard forbids the import, and rightly: #178 lifts that package out.
describe("#667: the permission picker and the EE classification declare the same types", () => {
  const read = (p: string) => readFileSync(resolve(import.meta.dirname, p), "utf8");

  it("every declared type is offerable, and nothing else is", () => {
    const declared = read("../../../../packages/ee-server/src/api-keys/classification.ts");
    const block = /export const RESOURCE_TYPES = \[([\s\S]*?)\] as const/.exec(declared)?.[1] ?? "";
    const types = new Set([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
    expect(types.size, "the declaration was parsed (a broken pattern must not pass vacuously)").toBeGreaterThan(10);

    const picker = read("./api-key-permissions.ts");
    const offered = new Set([...picker.matchAll(/\{\s*id:\s*"([a-z_]+)"/g)].map((m) => m[1]!));
    expect(offered.size, "the picker's list was found").toBeGreaterThan(10);

    expect([...types].filter((c) => !offered.has(c)), "declared and unofferable").toEqual([]);
    expect([...offered].filter((c) => !types.has(c)), "offered and undeclared — the server would refuse these").toEqual([]);
  });

  it("a type is marked writable only when some route requires write on it", () => {
    // The server refuses `search: write` with `unreachable_permission` — no route requires it, so the
    // cell would say the integration can write to search while nothing lets it. Offering a choice the
    // server will refuse is the #642 defect in a new place.
    const map = read("../../../../packages/ee-server/src/api-keys/classification.ts");
    const requiresWrite = new Set(
      [...map.matchAll(/\{\s*type:\s*'([a-z_]+)',\s*action:\s*'write'\s*\}/g)].map((m) => m[1]!),
    );
    expect(requiresWrite.size, "the requirements were parsed").toBeGreaterThan(3);

    const picker = read("./api-key-permissions.ts");
    const marked = new Set(
      [...picker.matchAll(/\{\s*id:\s*"([a-z_]+)",\s*writable:\s*true/g)].map((m) => m[1]!),
    );
    // One direction only, and deliberately: a type with no classified write route yet may still be
    // marked writable, because §4's classification is landing slice by slice and the flag describes the
    // model rather than today's coverage. What must not happen is the reverse — a type the map says is
    // written to, offered as read-only, which would hide a permission that works.
    expect([...requiresWrite].filter((c) => !marked.has(c)), "the map writes to these and the form will not offer it").toEqual([]);
    // …and the two read-only ones stay read-only, or the refusal above becomes reachable from the form.
    for (const readOnly of ["search", "audit"]) {
      expect(marked.has(readOnly), `${readOnly} has no write route and must not be offered as writable`).toBe(false);
    }
  });
});
