// #902: no browser walk asserts a raw subject as visible text.
//
// THE DEFECT was in the specs, not the product. `memberLabel` prefers the display name (#859), and the
// seeded admin has one — so the subject stopped appearing on screen and five assertions across four
// specs went looking for a string the product no longer renders. Session A hit two of them in a real
// run; the other three were found by counting, and nobody counts twice.
//
// ⚠️ The cost was larger than five red lines: `admin-gate.spec.ts` asserts this in its SECOND step, so
// the run never reached the destructive steps after it — a whole spec unmeasurable because of a label.
//
// The guard walks the specs. A sixth site added tomorrow is red the day it appears, and an entry that
// wants an exception has to say what different question it asks.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const SPECS = resolve(import.meta.dirname, "../../../../tests/e2e/specs");

// ⚠️ The subjects the seed creates, as they appear in the database. A spec may MENTION these (in a
// comment, in an API payload, as a fixture argument) — what it may not do is assert them as text a
// person sees. Extending this list is how the walk keeps up with the seed.
const SEEDED_SUBS = ["dev-user", "acme-user"];

// Assertions about what is on screen. Deliberately not "any string containing the sub": a spec that
// POSTs `{ sub: "dev-user" }` is talking to the API, and the API does speak subjects.
const SHOWN_TEXT = /(getByText|toContainText|hasText:|getByRole\([^)]*name:)\s*\(?\s*["'`]([^"'`]*)["'`]/g;

const ALLOWED = new Map<string, string>([
  // Nothing today. An entry here names the DIFFERENT question that assertion asks — "it happens to
  // contain the sub" is not a reason, because a member with no display name renders as
  // `unknown member (dev-user)`, which contains it too and is exactly the case this walk protects.
]);

const specs = existsSync(SPECS)
  ? readdirSync(SPECS).filter((f) => f.endsWith(".spec.ts"))
      .map((f) => ({ name: f, src: readFileSync(join(SPECS, f), "utf8") }))
  : [];

describe("#902 a walk asserts what the screen shows", () => {
  it("finds the walks at all", () => {
    // ⚠️ Without this the assertion below is green over an empty list — the shape #892 is about, and
    // the specs directory has moved once already (the sibling #889 guard says so).
    expect(specs.length, "the walk found spec files").toBeGreaterThan(20);
    expect(specs.map((s) => s.name), "including the ones #902 fixed").toContain("admin-gate.spec.ts");
  });

  it("no spec asserts a seeded subject as visible text", () => {
    const offenders: string[] = [];
    for (const { name, src } of specs) {
      for (const m of src.matchAll(SHOWN_TEXT)) {
        const text = m[2] ?? "";
        if (!SEEDED_SUBS.some((sub) => text.includes(sub))) continue;
        const key = `${name}:${text}`;
        if (!ALLOWED.has(key)) offenders.push(key);
      }
    }
    expect(offenders, `a walk asserting a raw subject on screen: ${offenders.join(", ")}`).toEqual([]);
  });
});
