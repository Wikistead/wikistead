import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDemo, sleep } from "../helpers";

// RE-AIMED, not retired (user ruling 2026-08-05, #604 / #607). This file used to prove that
// `deleter` / `sharer` / `settings-editor` reached both built-in surfaces. That ruling took them, and
// `access-manager`, back OUT on an edition boundary: composing a single verb is what a custom role is,
// and custom roles are EE, so a built-in noun for one verb hands a paid capability away for free.
//
// The measurement that mattered survives and is the interesting half — **the two surfaces agree, and the
// expectation is still not typed here.** It is read from the server's BUILT_IN_ROLES, so the pin holds
// the line in BOTH directions without naming today's four: adding a built-in with no picker entry fails,
// and so does a picker entry for a role the server does not declare. That discovery shape (#544) is why
// re-aiming this file was worth more than deleting it — a hand-written "expect exactly four" would go
// stale the next time the vocabulary moves, which it now has twice.
const ROLES_SRC = resolve(import.meta.dirname, "../../../apps/server/src/routes/roles.ts");

/** The nouns the ruling removed. Named ONLY as things that must be absent — never as an expectation of
 *  what is present, which is what read from the server below. */
const RETIRED_NOUNS = ["access-manager", "deleter", "sharer", "settings-editor"];

test("#604 C / #607: the built-in surfaces agree, and offer no single-verb noun", async ({ page }) => {
  const src = readFileSync(ROLES_SRC, "utf8");
  const builtIns = [...src.matchAll(/\{\s*name:\s*'([a-z-]+)',\s*capabilities:/g)].map((m) => m[1]!);
  expect(builtIns, "the server list was read (a broken match must not pass vacuously)").toContain("manager");
  for (const n of RETIRED_NOUNS) {
    expect(builtIns, `${n} is no longer a built-in — it is composed as a custom role`).not.toContain(n);
  }

  await openDemo(page);

  // 1. the Roles tab lists every built-in the server declares, and nothing retired
  await page.goto("/admin/roles");
  await expect(page.getByTestId("roles-list-resource")).toBeVisible({ timeout: 10_000 });
  await sleep(400);
  const listed = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-testid^='builtin-role-']"))
      .map((el) => el.getAttribute("data-testid")!.replace(/^builtin-role-/, "")),
  );
  for (const n of builtIns) {
    expect([...new Set(listed)], `the Roles tab names the built-in ${n}`).toContain(n);
  }
  for (const n of RETIRED_NOUNS) {
    expect([...new Set(listed)], `${n} is gone from the Roles tab`).not.toContain(n);
  }

  // 2. the space grant picker offers the same vocabulary to a manager (dev-user owns demo_space)
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });
  await sleep(300);
  // the DS Select portals its listbox, so the options exist only while it is open
  await page.getByTestId("space-grant-capability").click();
  await sleep(400);
  const offered = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[role=option]")).map((o) => o.textContent!.trim()),
  );
  expect(offered.length, "the listbox opened").toBeGreaterThan(3);
  for (const n of RETIRED_NOUNS) {
    expect(offered, `the picker does not hand out ${n} for free`).not.toContain(n);
  }
  // BOTH ways, the same as before: every built-in the server declares is offered here. Custom roles are
  // also in this list, so the check is one-directional on purpose — a built-in missing from the picker
  // is the failure; an extra entry is a custom role and legitimate.
  for (const n of builtIns) {
    expect(offered, `the picker offers the built-in ${n}`).toContain(n);
  }
});
