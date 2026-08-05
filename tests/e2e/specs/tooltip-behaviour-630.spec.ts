import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #630 (user ruling, 2026-08-05): " tooltip ".
//
// Four implementations had drifted into three open delays (180 / 180 / 0), two close graces (0 / 160)
// and animation on exactly one of them. Placement was unified in #603 and the box in #582; this is the
// behaviour, and it is the part a reader actually feels — a panel that appears instantly on one screen
// and after a beat on the next reads as two different products.
//
// The comparison is between the RADIX tooltip and the HAND-PLACED panels, because those are the two
// mechanisms; naming surfaces would miss the fifth one somebody adds. And the premise is asserted first
// #582records three pins in a row that were green while broken, because the sweep only ever
// reached the Radix side. A comparison of one thing with itself is always equal.
const MEMBERS = {
  members: [
    { sub: "gr630", email: "g@x.test", display_name: "Has Groups", picture_url: null, role: "member", groups: ["G1", "G2"], created_at: "2026-01-01T00:00:00Z", identity_source: "oidc", has_password: false, deactivated_at: null },
  ],
};
const ASSIGNMENTS = [
  { id: "a1", roleId: null, roleName: "admin", builtin: "admin", principal: "group:h1#member", groupName: "G1" },
  { id: "a2", roleId: "r-bbb", roleName: "bbb", principal: "group:h2#member", groupName: "G2" },
];

async function stub(page: import("@playwright/test").Page) {
  await page.route("**/api/members", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMBERS) })
      : r.fallback());
  await page.route("**/api/admin/roles/assignments**", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ASSIGNMENTS) })
      : r.fallback());
}

/** Every floating explanation currently on screen, with the motion it was given. */
async function livePanels(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role=tooltip], [data-slot=tooltip-content], [data-role-panel], .wks-tip')]
      .map((el) => {
        const box = el.getBoundingClientRect();
        // The animation sits on the FLOATING BOX, and the element the sweep found may be the content
        // inside it — RoleTip's `data-role-panel` div is rendered into whichever box raised it, which is
        // a Radix tooltip on one surface and a Select's hint on another. So walk up until an animation
        // is found rather than guessing which ancestor carries it; that also means the check does not
        // break when a fifth implementation nests differently.
        let node: HTMLElement | null = el as HTMLElement;
        let name = 'none';
        let dur = '';
        while (node && name === 'none') {
          const cs = getComputedStyle(node);
          if (cs.animationName !== 'none') { name = cs.animationName; dur = cs.animationDuration; }
          node = node.parentElement;
        }
        return {
          id: (el as HTMLElement).dataset.testid ?? (el as HTMLElement).className.slice(0, 40),
          radix: !!el.closest('[data-slot=tooltip-content]'),
          visible: box.width > 0 && box.height > 0,
          animationName: name,
          animationDuration: dur,
        };
      })
      .filter((p) => p.visible));
}

test("#630: the delay, the grace and the entrance are one behaviour across implementations", async ({ page }) => {
  await stub(page);
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByText("Has Groups")).toBeVisible({ timeout: 10_000 });
  await sleep(500);

  const mark = page.getByTestId("group-roles-mark").first();
  const trigger = page.locator('tr', { hasText: "Has Groups" }).getByTestId("member-role-select");

  // ── the delay: neither is showing before it elapses, both are showing after ────────────────────
  await mark.hover();
  expect((await livePanels(page)).length, "the hand-placed panel does not jump out before the delay").toBe(0);
  await sleep(400);
  const afterMark = await livePanels(page);
  expect(afterMark.length, "…and does appear once it has").toBeGreaterThan(0);
  const handPlaced = afterMark.find((p) => !p.radix);
  expect(handPlaced, "the premise: a HAND-PLACED panel is on screen (not only the Radix one)").toBeTruthy();

  await page.mouse.move(0, 0);
  await sleep(600);

  await trigger.hover();
  expect((await livePanels(page)).length, "the select's hint waits the same delay").toBe(0);
  await sleep(400);
  const afterTrigger = await livePanels(page);
  expect(afterTrigger.length, "the select's hint appears after it").toBeGreaterThan(0);

  // The Radix mechanism lives on a DIFFERENT screen — the roles list raises `RoleTip` directly, where
  // the members table only ever reaches it through a hand-placed box. Measured: with a single screen,
  // restoring `animated={false}` left this test GREEN, because the Radix side was never on it. That is
  // the exact shape #582recorded three times, so the premise below is asserted without a
  // fallback: no Radix panel means the comparison never happened, and the test says so.
  await page.mouse.move(0, 0);
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 }).catch(() => {});
  await sleep(600);
  const roleName = page.locator('[data-testid^="role-tip-"]').first();
  await expect(roleName, "the roles screen offers a Radix-raised panel to hover").toBeVisible({ timeout: 8_000 });
  await roleName.hover();
  await sleep(400);
  const afterRole = await livePanels(page);
  const radix = afterRole.find((p) => p.radix);
  expect(radix, "the premise: the RADIX mechanism reached the screen (else this compares one thing with itself)").toBeTruthy();

  // ── the entrance: same animation, same duration, whichever mechanism drew it ───────────────────
  const seen = [...afterMark, ...afterTrigger, ...afterRole];
  for (const p of seen) {
    expect(p.animationName, `${p.id} animates like the rest`).not.toBe("none");
  }
  expect(new Set(seen.map((p) => p.animationDuration)).size,
    `one duration across implementations — saw ${seen.map((p) => `${p.id}:${p.animationDuration}`).join(", ")}`).toBe(1);

  // ── the grace: leaving does not snap it away (this is what #603's nested walk rides on) ────────
  await page.mouse.move(0, 0);
  await page.goto("/admin/members");
  await expect(page.getByText("Has Groups")).toBeVisible({ timeout: 10_000 });
  await sleep(500);
  await page.getByTestId("group-roles-mark").first().hover();
  await sleep(400);
  expect((await livePanels(page)).length, "open before measuring the grace").toBeGreaterThan(0);
  await page.mouse.move(0, 0);
  await sleep(60);
  expect((await livePanels(page)).length, "still there a moment after the pointer left").toBeGreaterThan(0);
  await sleep(400);
  expect((await livePanels(page)).length, "and gone once the grace elapsed").toBe(0);
});

test("#630: the nested walk still works with the delay in front of it (#603 non-regression)", async ({ page }) => {
  await stub(page);
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByText("Has Groups")).toBeVisible({ timeout: 10_000 });
  await sleep(500);

  await page.getByTestId("group-roles-mark").first().hover();
  const list = page.getByTestId("group-roles-list");
  await expect(list).toBeVisible({ timeout: 3_000 });
  await list.getByTestId("group-role-name").first().hover();
  await expect(page.getByTestId("group-role-caps"), "the second tier still opens").toBeVisible({ timeout: 3_000 });
  await expect(list, "and the first is still there to read").toBeVisible();
});
