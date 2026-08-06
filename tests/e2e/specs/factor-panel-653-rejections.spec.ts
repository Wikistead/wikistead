import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #653 four things the user found on the device, none of which any green test noticed.
//
// ② and ④ are why this is an e2e rather than a unit. "The icon shrank when I pressed delete" is a
// claim about LAYOUT — a class list cannot answer it, because `size={16}` on an svg is a width
// ATTRIBUTE that flex is free to override, and the class that stops it is exactly what was missing.
// And a rename is only fixed if the new name survives a reload, which is a claim about the server.
const SEC = "/settings/account/security";

// SERIAL. Every test here enrols on the SAME account, and starting an enrolment deliberately discards
// that member's own abandoned starts (#653 ① — the fix for the invisible rows that ate the cap).
// Run in parallel, the three of them delete each other's pending row and every one reports that
// enrolment is broken. The product is right; concurrent enrolment by one person is not a real case.
test.describe.configure({ mode: "serial" });

/** RFC 6238 from the key on screen — the route a person's phone takes, and the only one open here. */
async function totpFor(page: import("@playwright/test").Page, secretKey: string): Promise<string> {
  return page.evaluate(async (secret: string) => {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const ch of secret.toUpperCase()) { const i = A.indexOf(ch); if (i >= 0) bits += i.toString(2).padStart(5, "0"); }
    const bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    const ctr = new Uint8Array(8);
    let step = Math.floor(Date.now() / 1000 / 30);
    for (let i = 7; i >= 0; i--) { ctr[i] = step & 0xff; step = Math.floor(step / 256); }
    const k = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, ctr));
    const off = mac[19]! & 0x0f;
    const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
    return String(bin % 1_000_000).padStart(6, "0");
  }, secretKey);
}

async function enrol(page: import("@playwright/test").Page, label: string): Promise<string> {
  // Wait for the panel, not just the input: filling before hydration lands the value nowhere and the
  // click that follows does nothing, which then reads as "enrolment is broken".
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  // Retried once, and the reason is a property of the product rather than of this spec: starting an
  // enrolment DISCARDS this member's own abandoned starts (#653 ① — the fix for the invisible
  // rows that ate the cap). Every factor spec signs in as the same seeded member, and Playwright runs
  // spec FILES in parallel, so a neighbouring file's enrolment can delete the pending row this one is
  // waiting on. `mode: "serial"` orders this file's tests and cannot reach across files.
  for (let attempt = 0; ; attempt++) {
    await page.getByTestId("factor-label-input").fill(label);
    await page.getByTestId("factor-add").click();
    try {
      await expect(page.getByTestId("factor-secret-value")).toBeVisible({ timeout: 15_000 });
      break;
    } catch (e) {
      if (attempt >= 1) throw e;
      await page.reload();
      await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
    }
  }
  // The code is computed from the key on screen — the same route a person's phone takes, and the only
  // way this spec can confirm without a device.
  // `factor-secret` is the WRAPPER — it contains the copy button and the note, so its innerText is
  // prose with a key buried in it, and base32-decoding that yields a code the server rightly rejects.
  // The value has its own testid; the existing 653 spec uses it for the same reason.
  const key = (await page.getByTestId("factor-secret-value").innerText()).replace(/\s/g, "");
  const code = await totpFor(page, key);
  await page.getByTestId("factor-confirm-code").fill(code);
  await page.getByTestId("factor-confirm").click();
  await expect(page.getByTestId("factor-row").filter({ hasText: label })).toBeVisible({ timeout: 10_000 });
  return key;
}

/**
 * Take it back off. Not tidiness — the account is shared by every test in this file and the server caps
 * it at ten, so a run that leaves its factors behind makes the NEXT run fail for a reason that has
 * nothing to do with what it measures. That exact debris produced two false reds while this spec was
 * being written, and #653 recorded the same trap one round earlier.
 */
async function removeFactor(page: import("@playwright/test").Page, label: string, key: string): Promise<void> {
  // The panel first. Every `count` below is satisfied by a page that has not rendered, so without
  // this the helper returns "nothing to remove" precisely when the list is slow — which is how a
  // confirmed row survived a green cleanup and broke the next spec file.
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("factor-add")).toBeVisible({ timeout: 20_000 });
  const row = page.getByTestId("factor-row").filter({ hasText: label });
  if (!(await row.count())) return;
  await row.first().getByTestId("factor-remove").click();
  const field = row.first().getByTestId("factor-remove-code");
  if (await field.count()) {
    await field.fill(await totpFor(page, key));
    await row.first().getByTestId("factor-remove-confirm").click();
  }
  await expect(row, "the spec left a factor behind").toHaveCount(0, { timeout: 10_000 });
}

test("#653 ②: pressing delete does not shrink the row's icon", async ({ page }) => {
  test.setTimeout(180_000);
  await openDemo(page);
  await page.goto(SEC);
  const name = `icon-${Date.now().toString(36)}`;
  const key = await enrol(page, name);

  const row = page.getByTestId("factor-row").filter({ hasText: name });
  const shield = row.locator("svg").first();
  const before = await shield.boundingBox();

  await row.getByTestId("factor-remove").click();
  await expect(row.getByTestId("factor-remove-code")).toBeVisible({ timeout: 5_000 });
  await sleep(200); // past any transition
  const after = await shield.boundingBox();

  // Compared as GEOMETRY. The row now holds an input and two buttons, and without `flex-none` the svg
  // is just another flex item with something to give.
  expect(before, "the shield is measurable").not.toBeNull();
  expect(after!.width, `the icon shrank on delete: ${before!.width} → ${after!.width}`).toBeCloseTo(before!.width, 0);
  expect(after!.height, "…and vertically").toBeCloseTo(before!.height, 0);
  expect(after!.width, "…and it is still the size it was drawn at").toBeGreaterThan(12);
  await page.reload();
  await removeFactor(page, name, key);
});

test("#653 ④: a factor can be renamed, and the new name outlives a reload", async ({ page }) => {
  test.setTimeout(180_000);
  await openDemo(page);
  await page.goto(SEC);
  const name = `rn-${Date.now().toString(36)}`;
  const key = await enrol(page, name);

  const row = page.getByTestId("factor-row").filter({ hasText: name });
  await row.getByTestId("factor-rename").click();
  const renamed = `${name}-2`;
  await page.getByTestId("factor-rename-input").fill(renamed);
  await page.getByTestId("factor-rename-save").click();
  await expect(page.getByTestId("factor-row").filter({ hasText: renamed })).toBeVisible({ timeout: 10_000 });

  // The reload is the assertion. Renaming only in local state would pass everything above it.
  await page.reload();
  await expect(page.getByTestId("factor-row").filter({ hasText: renamed }), "the new name did not reach the server")
    .toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("factor-row").filter({ hasText: new RegExp(`${name}$`) }), "the old name is gone")
    .toHaveCount(0);
  await removeFactor(page, renamed, key);
});

test("#653 ④: renaming asks for no code — possession guards the door, not the label", async ({ page }) => {
  test.setTimeout(180_000);
  await openDemo(page);
  await page.goto(SEC);
  const name = `nc-${Date.now().toString(36)}`;
  const key = await enrol(page, name);

  const row = page.getByTestId("factor-row").filter({ hasText: name });
  await row.getByTestId("factor-rename").click();
  // #660 asks for a current code before REMOVAL. If that spread to renaming, somebody without their
  // phone to hand could never correct a typo — and the row's own delete field would be sitting there
  // as the model to copy.
  await expect(row.getByTestId("factor-remove-code"), "renaming asked for a code").toHaveCount(0);
  await page.getByTestId("factor-rename-input").fill(`${name}-ok`);
  await page.getByTestId("factor-rename-save").click();
  await expect(page.getByTestId("factor-row").filter({ hasText: `${name}-ok` })).toBeVisible({ timeout: 10_000 });
  await removeFactor(page, `${name}-ok`, key);
});

test("#653 ①③: the labels say what they mean, in Japanese", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "ja"); } catch { /* private */ } });
  await openDemo(page);
  await page.goto(SEC);
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  // The PAGE, not the panel. `factorsTitle` and `factorsDesc` are the SettingsPage heading
  // (`AccountPage.tsx:549`) and live outside `second-factor-panel` — scoping to the panel measured only
  // `factorsHint`, so two of the three strings below were unasserted. Caught by breaking this pin
  // reverting the title left it green.
  const text = await page.locator("body").innerText();

  // ③ the four the user called unnatural, each asserted as ABSENT — a pin on the new string alone
  // would go green while the old one still sat two lines up.
  expect(text, "「2 段階のサインイン」が残っています").not.toContain("2 段階のサインイン");
  expect(text, "「…コードを聞きます」が残っています").not.toContain("コードを聞きます");
  expect(text, "「動くことを確かめます」が残っています").not.toContain("動くことを確かめます");

  // …and one screen must not say both verbs. That is the reason factorRemoved and factorLimit moved
  // too, and it is invisible unless both are checked at once.
  const name = `ja-${Date.now().toString(36)}`;
  const key = await enrol(page, name);
  const after = await page.locator("body").innerText();
  expect(after.includes("外す") && after.includes("削除"), "1 画面に「外す」と「削除」が混在").toBe(false);

  // ① the label the user could not read
  await page.getByTestId("factor-add").click();
  await expect(page.getByTestId("factor-secret-value")).toBeVisible({ timeout: 15_000 });
  await page.reload();
  const mark = page.getByTestId("factor-pending-mark").first();
  await expect(mark).toBeVisible({ timeout: 20_000 });
  expect((await mark.innerText()).trim(), "「未完了」のままです").not.toBe("未完了");
  // Both: the confirmed one, and the pending row this test opened just above. A pending row needs no
  // code (#660), so its remove is immediate.
  const pending = page.getByTestId("factor-row").filter({ hasText: /確認待ち/ });
  while (await pending.count()) {
    await pending.first().getByTestId("factor-remove").click();
    await sleep(400);
  }
  await removeFactor(page, name, key);
  // Anything else this file created — a retried enrolment can leave a sibling under a name no test
  // still remembers. Confirmed rows need a code, and `key` is the only one this file holds.
  for (const stray of await page.getByTestId("factor-row").all()) {
    await stray.getByTestId("factor-remove").click();
    const f = stray.getByTestId("factor-remove-code");
    if (await f.count()) { await f.fill(await totpFor(page, key)); await stray.getByTestId("factor-remove-confirm").click(); }
    await sleep(400);
  }
  // ASSERTED, not assumed. This spec shares one seeded member with every other factor spec, and the
  // suite runs single-worker — so a row left here is not this file's problem, it is the next file's.
  // One stray pending row was breaking `second-factor-ui-653`'s count, and nothing here said so.
  await page.reload();
  // Wait for the PANEL before counting rows. `toHaveCount(0)` is satisfied by a page that has not
  // rendered yet, so without this the assertion passes hardest exactly when the list is slowest
  // and it did: it reported zero while a confirmed row sat in the database.
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("factor-add"), "the panel is interactive, not mid-load").toBeVisible();
  await expect(page.getByTestId("factor-row"), "this spec left factors behind for the next one")
    .toHaveCount(0, { timeout: 15_000 });
});
