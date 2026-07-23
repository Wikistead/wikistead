// #510: the regression guard for the #504 destructive-operation policy. The fs-walking case is the
// guard proper (red the day an unguarded delete lands); the fixture cases prove the analyzer itself
// is not vacuous (an unguarded call IS flagged; the allowlist IS doing work).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { analyzeDestructive, hasDangerTrigger, ALLOWLIST, LEGACY_FILES } from "./destructive-guard";

const SRC = resolve(import.meta.dirname, "..");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe("destructive-operation policy guard (#510)", () => {
  it("every destructive invocation is confirm-guarded or allowlisted, and its file paints a danger trigger", () => {
    const violations: string[] = [];
    const filesWithDestructiveSites: string[] = [];
    for (const f of tsxFiles(SRC)) {
      const src = readFileSync(f, "utf8");
      const base = basename(f);
      const v = analyzeDestructive(base, src);
      // does the file have ANY destructive shape (guarded or not)? — for the danger-trigger check
      const anyDestructive = v.length > 0 || Object.keys(ALLOWLIST).some((k) => k.startsWith(`${base}:`));
      if (anyDestructive) filesWithDestructiveSites.push(base);
      for (const x of v) violations.push(`${base}:${x.identifier} — destructive call outside a confirm context (add a ConfirmDialog or an ALLOWLIST entry with a reason)`);
      if (anyDestructive && !LEGACY_FILES.has(base) && !hasDangerTrigger(src)) violations.push(`${base} — has destructive actions but paints no danger trigger (red at rest is the #504 policy)`);
    }
    // the walk found real destructive surfaces (a broken walker must not pass vacuously)
    expect(filesWithDestructiveSites.length).toBeGreaterThanOrEqual(5);
    expect(violations, "the #504 policy holds across the web source").toEqual([]);
  });

  it("flags an unguarded delete (the analyzer is not vacuous)", () => {
    const fixture = `
      const del = useDeleteFoo();
      export function Foo() {
        return <button onClick={() => del.mutate(1)}>x</button>;
      }`;
    const v = analyzeDestructive("Fixture.tsx", fixture, {});
    expect(v.map((x) => x.identifier)).toEqual(["del"]);
  });

  it("accepts the same call once it runs from a confirm context", () => {
    const confirmed = `
      const del = useDeleteFoo();
      export function Foo() {
        return <ConfirmDialog onConfirm={() => del.mutate(1)} />;
      }`;
    expect(analyzeDestructive("Fixture.tsx", confirmed, {})).toEqual([]);
    const deferred = `
      const del = useDeleteFoo();
      export function Foo() {
        return <button onClick={() => setConfirming({ run: () => del.mutate(1) })}>x</button>;
      }`;
    expect(analyzeDestructive("Fixture.tsx", deferred, {})).toEqual([]);
  });

  it("the allowlist is load-bearing — removing an entry turns the real file red", () => {
    // AdminRolesTab's unassign is a sanctioned red-only exception; without its entry it must violate.
    const f = join(SRC, "settings/AdminRolesTab.tsx");
    const src = readFileSync(f, "utf8");
    const without = { ...ALLOWLIST };
    delete without["AdminRolesTab.tsx:unassign"];
    const v = analyzeDestructive("AdminRolesTab.tsx", src, without);
    expect(v.map((x) => x.identifier), "unassign is only green because it is allowlisted").toContain("unassign");
    // …and with the shipped allowlist it is green
    expect(analyzeDestructive("AdminRolesTab.tsx", src).map((x) => x.identifier)).not.toContain("unassign");
  });
});
