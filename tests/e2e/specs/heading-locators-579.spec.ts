import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// #579: a heading locator that matches by SUBSTRING breaks the day a screen grows a second
// heading that starts with the same word.
//
// What happened: #579 added "Members and groups" beside "Members", and three specs that asked for
// `getByRole("heading", { name: "Members" })` began resolving to two elements. All three measure the
// authorization ENTRANCE (the console opens for an admin, is refused to a member, an invitee is
// seated), so they are exactly the pins whose silence is expensive — and each was handed on twice as
// "red on clean master too", which is true and is how a red survives three sessions.
//
// Fixing the three would leave the fourth. This is the rule instead: a heading is asked for by its
// whole name (`exact: true`) or by a testid. Nothing here names a screen, so a heading added tomorrow
// cannot quietly make an old pin ambiguous.
const SPECS = resolve(import.meta.dirname);

const files = (): string[] =>
  readdirSync(SPECS)
    .filter((f) => f.endsWith(".spec.ts") && f !== "heading-locators-579.spec.ts")
    .map((f) => join(SPECS, f));

test("#579: no spec asks for a heading by substring", async () => {
  const offenders: string[] = [];
  for (const file of files()) {
    const src = readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      // the shape under test: getByRole("heading", { name: <something> }) with no `exact`
      const m = /getByRole\(\s*["']heading["']\s*,\s*\{([^}]*)\}/.exec(line);
      if (!m) return;
      const opts = m[1]!;
      if (!/\bname\s*:/.test(opts)) return; // no name → nothing to be ambiguous about
      if (/exact\s*:\s*true/.test(opts)) return; // anchored
      if (/name\s*:\s*\//.test(opts)) return; // a RegExp says exactly what it means
      offenders.push(`${file.slice(SPECS.length + 1)}:${i + 1} — ${line.trim().slice(0, 90)}`);
    });
  }
  expect(offenders, "a heading asked for by substring: it will resolve to two the day a sibling heading is added").toEqual([]);
});
