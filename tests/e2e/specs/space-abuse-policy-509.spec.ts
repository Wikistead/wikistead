import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #509 / ADR-187: the per-space moderation policy UI lives in the space's Patrol (moderation) tab. A
// space manager (dev-user, superset of moderator) sets a space-only banned word; the editor persists it
// and the effective policy reflects it. The floor-can't-be-weakened algebra + moderate-gate are pinned
// server-side (space-abuse-policy-509.test.ts); this pins the UI round-trip on a real browser.
const H = { authorization: "Bearer dev-token", "content-type": "application/json" };

test("#509: a manager sets a space-only banned word in the Patrol tab and it takes effect", async ({ page }) => {
  await openDemo(page);
  const spaceId = await page.evaluate(async ({ h }) => {
    const r = await fetch("/api/spaces", { method: "POST", headers: h, body: JSON.stringify({ name: `abuse509-${Date.now().toString(36)}` }) });
    return (await r.json()).id as string;
  }, { h: H });

  await page.goto(`/spaces/${spaceId}/settings/moderation`);
  await expect(page.getByTestId("space-abuse-filter")).toBeVisible({ timeout: 10000 });

  // set a space-only banned word
  await page.getByTestId("space-abuse-words").fill("banana\nvandalism");
  await page.getByTestId("space-abuse-save").click();
  await sleep(600);

  // reload → the word persists, and the effective line counts it (tenant floor is empty on a fresh tenant col)
  await page.reload();
  await expect(page.getByTestId("space-abuse-words")).toHaveValue(/banana/, { timeout: 10000 });
  await expect(page.getByTestId("space-abuse-effective")).toContainText(/2/); // 2 banned words in effect

  // the API confirms the effective policy carries the space word
  const eff = await page.evaluate(async ({ id, h }) => {
    const r = await fetch(`/api/spaces/${id}/abuse-filter`, { headers: { authorization: h.authorization } });
    return (await r.json()) as { effective: { bannedWords: string[] }; space: { bannedWords: string[] } };
  }, { id: spaceId, h: H });
  expect(eff.space.bannedWords).toEqual(expect.arrayContaining(["banana", "vandalism"]));
  expect(eff.effective.bannedWords).toEqual(expect.arrayContaining(["banana", "vandalism"]));
});
