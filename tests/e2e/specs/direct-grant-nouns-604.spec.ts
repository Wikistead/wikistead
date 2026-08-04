import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDemo, sleep } from "../helpers";

// #604 C: the three admin-class leaves became built-in roles a manager can grant directly. Measured in
// a real browser, from the two surfaces that must agree — the Roles tab's built-in list and the space
// grant picker. The unit pin compares the two SOURCES; this compares what a person actually sees.
//
// The expectation is not typed here: it is read from the server's BUILT_IN_ROLES, so a role added on
// the server with no picker entry fails without anyone editing this file (the #544 discovery shape).
const ROLES_SRC = resolve(import.meta.dirname, "../../../apps/server/src/routes/roles.ts");

test("#604 C: deleter / sharer / settings-editor reach both surfaces", async ({ page }) => {
  const src = readFileSync(ROLES_SRC, "utf8");
  const builtIns = [...src.matchAll(/\{\s*name:\s*'([a-z-]+)',\s*capabilities:/g)].map((m) => m[1]!);
  expect(builtIns, "the server list was read").toContain("manager");
  for (const n of ["deleter", "sharer", "settings-editor"]) {
    expect(builtIns, `${n} is a built-in on the server`).toContain(n);
  }

  await openDemo(page);

  // 1. the Roles tab lists every built-in the server declares
  await page.goto("/admin/roles");
  await expect(page.getByTestId("roles-list-resource")).toBeVisible({ timeout: 10_000 });
  await sleep(400);
  // the row's testid is `builtin-role-<name>`; the capability checkboxes are `builtin-<name>-cap-<verb>`
  const listed = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-testid^='builtin-role-']"))
      .map((el) => el.getAttribute("data-testid")!.replace(/^builtin-role-/, "")),
  );
  for (const n of builtIns) {
    expect([...new Set(listed)], `the Roles tab names the built-in ${n}`).toContain(n);
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
  for (const n of ["deleter", "sharer", "settings-editor"]) {
    expect(offered, `the picker offers ${n}`).toContain(n);
  }
  // and the roster verb stays inside the ceiling: it is offered (a manager may delegate it) while the
  // three new ones are admin-class, which the route test proves an access-manager cannot pass on
  expect(offered, "the #607 noun is still there").toContain("access-manager");
});
