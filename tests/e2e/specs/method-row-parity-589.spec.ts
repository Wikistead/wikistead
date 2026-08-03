import { test, expect } from "@playwright/test";

// #589 (review rejection): " ON/OFF SAML
//
// One row per sign-in method was the whole point of the ticket, and three hand-written row shapes is
// what it actually shipped: the password row switched from the row, the OIDC row switched from a stack
// below it, SAML switched only after expanding and saving, and "add a connection" opened a card with
// different padding OUTSIDE the list.
//
// The pin walks the rows instead of naming the methods (#544): every row carries `data-method-row`, so
// the fifth method (local users, #568) is measured by existing rather than by someone remembering to
// add it here. What is compared is what a reader sees — computed padding, and where the on/off control
// sits — not the classes that produce it.
test("#589: every sign-in method is the same kind of row", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/admin/auth");
  await expect(page.getByTestId("sign-in-methods")).toBeVisible({ timeout: 15_000 });

  const measure = () => page.evaluate(() => {
    const list = document.querySelector("[data-testid=sign-in-methods-list]")!;
    return [...list.querySelectorAll<HTMLElement>("[data-method-row]")].map((row) => {
      const cs = getComputedStyle(row);
      // the row's FIRST switch is the method's on/off by construction; a connection row also carries an
      // MCP switch (#592) further down, which is a different question and is not what this measures
      const sw = row.querySelector("[data-slot=switch], button[role=switch]");
      const head = row.firstElementChild;
      return {
        id: row.getAttribute("data-testid") ?? "?",
        pad: `${cs.paddingTop}/${cs.paddingRight}/${cs.paddingBottom}/${cs.paddingLeft}`,
        inList: list.contains(row),
        // the on/off control, if the row has one, must hang off the row's FIRST line — the same place
        // on every row. A switch parked in a stack below the head is a different act to perform.
        switchInHead: sw ? !!head?.contains(sw) : null,
      };
    });
  });

  const rows = await measure();
  expect(rows.length, "the list drew rows to compare").toBeGreaterThan(1);
  expect([...new Set(rows.map((r) => r.pad))], `rows disagree on padding: ${JSON.stringify(rows)}`).toHaveLength(1);
  expect(rows.filter((r) => r.switchInHead === false).map((r) => r.id), "every switch sits on the row's first line").toEqual([]);

  // …and adding a connection extends the list rather than opening a card beside it
  await page.getByTestId("admin-connection-add").click();
  await expect(page.getByTestId("admin-connection-form")).toBeVisible();
  const withForm = await measure();
  expect(withForm.some((r) => r.id === "admin-connection-form"), "the add form is a row IN the list").toBe(true);
  expect([...new Set(withForm.map((r) => r.pad))], `the add row disagrees on padding: ${JSON.stringify(withForm)}`).toHaveLength(1);
});
