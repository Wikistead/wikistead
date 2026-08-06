import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #637 / ADR-216 slice 7: a narrowed key can be issued FROM THE PRODUCT.
//
// Five slices of enforcement and one of API existed before anything a person could press. Driven through
// the screen because that is the claim — the route existing on the server is not the same as an admin
// being able to confine a key from where they are looking (the same reasoning #638's hand-off pin uses).
//
// Run against the EE entrypoint, which is what the e2e stack starts: narrowing is EE, so on a CE build
// the route is absent and the affordance must not appear at all.
test("#637: an admin can confine a key to a space, and the key says so", async ({ page }) => {
  test.setTimeout(180_000);
  await openDemo(page);
  await page.goto("/admin/api");
  await sleep(1200);
  await expect(page.getByTestId("api-key-name")).toBeVisible({ timeout: 20_000 });

  // the narrowing form is closed until it is asked for — an unnarrowed key is the common case
  await expect(page.getByTestId("api-key-narrow"), "closed by default").toHaveCount(0);
  await page.getByTestId("api-key-narrow-toggle").click();
  await expect(page.getByTestId("api-key-narrow")).toBeVisible();

  const options = page.getByTestId("api-key-space-option");
  expect(await options.count(), "the tenant's spaces are offered (flat — no tree here)").toBeGreaterThan(0);

  const stamp = Date.now().toString(36);
  await page.getByTestId("api-key-name").fill(`ui637-${stamp}`);
  await page.getByTestId("api-key-space-demo_space").check();
  await page.getByTestId("api-key-create").click();

  // the plaintext comes back in the box #638 made shared — not a third way of showing a secret
  await expect(page.getByTestId("api-key-plaintext-value")).toBeVisible({ timeout: 20_000 });
  const plaintext = (await page.getByTestId("api-key-plaintext-value").textContent())!.trim();
  expect(plaintext, "a usable key").toMatch(/^wks_/);

  // …and it really is confined. Measured at the CONTENTS with an unconfined control beside it: this
  // route answers 200 either way, so the status said nothing — the review found a confinement
  // that let through zero pages while this line stayed green. An empty list can mean an empty space,
  // which is why the control has to see something for the number to mean anything.
  // The control comes from the same form with nothing ticked, rather than from a fetch: the app's own
  // requests carry a token this page holds, and a bare fetch from the console does not — it answers 401
  // and would read as "the control could not be issued" rather than as a test making a wrong call.
  await page.getByTestId("api-key-name").fill(`ui637-control-${stamp}`);
  await page.getByTestId("api-key-create").click();
  // Waited on the VALUE CHANGING, not on the box being visible: the box is already showing the first
  // key, so "visible" is true before the second request has answered and the read would hand back the
  // secret from a moment ago. (Caught by the inequality below, which is why it is there.)
  await expect
    .poll(async () => (await page.getByTestId("api-key-plaintext-value").textContent())?.trim(), { timeout: 20_000 })
    .not.toBe(plaintext);
  const control = (await page.getByTestId("api-key-plaintext-value").textContent())!.trim();
  expect(control, `a control key was issued :: ${control}`).toMatch(/^wks_/);
  expect(control, "…and it is a different key from the confined one").not.toBe(plaintext);

  const probe = await page.evaluate(async ([confined, plain]) => {
    const count = async (token: string) => {
      const r = await fetch("/api/spaces/demo_space/pages", { headers: { authorization: `Bearer ${token}` } });
      const body: unknown = r.ok ? await r.json() : null;
      const rows = Array.isArray(body) ? body : ((body as { items?: unknown[] })?.items ?? []);
      return { status: r.status, n: rows.length };
    };
    return { own: await count(confined), control: await count(plain!) };
  }, [plaintext, control] as const);

  expect(probe.control.n, `the control sees pages, so there is something to lose :: ${JSON.stringify(probe)}`).toBeGreaterThan(0);
  expect(probe.own.n, `the confined key sees its own space :: ${JSON.stringify(probe)}`).toBe(probe.control.n);

  // the row it produced is listed
  await expect(page.getByTestId("api-key-list")).toContainText(`ui637-${stamp}`);
});
