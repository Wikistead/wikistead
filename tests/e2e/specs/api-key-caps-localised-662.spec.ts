import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #662: the capability checkboxes in the API key form read `roleCaps.${c}` — a namespace present in
// neither locale — and i18next's fallback painted the raw wire verb. A Japanese admin was offered
// "view edit publish delete comment manage" beside .
//
// What makes this worth an e2e rather than only the unit scan: the unit scan proves the KEY exists, and
// the screen is where "does a Japanese reader see Japanese" is actually answered. The two measure
// different things, and the reason this shipped at all is that everything upstream of the screen was
// green.
//
// Measured as "no raw wire verb survives", not as "some Japanese appears". A pin that looked for
// would stay green if five of the six labels were still English, and a pin that asserted a specific
// string would break the day the copy is reworded — which #659 just did to its neighbours.
// ⚠️ #667 replaced the six borrowed role verbs with the resource-type x read/write table, so the list
// this spec was written against no longer exists and it went red on master. What it measures survives
// the change intact — a Japanese admin must be offered Japanese, not the wire vocabulary — so it is
// repointed at the table rather than deleted, and the wire words it forbids are the new ones.
//
// The type ids are the wire vocabulary now (`pages`, `page_publishing`, `space_settings`, …), and the
// actions still are (`read`, `write`). Both are checked: a missing `adminApi.type.*` key would paint the
// id, and a missing `adminApi.action_*` would paint the verb, which is exactly what #662 shipped.
const WIRE_WORDS = [
  "pages", "page_publishing", "page_lifecycle", "page_sharing", "page_moderation", "comments",
  "attachments", "search", "recent", "spaces", "space_settings", "space_publishing", "space_lifecycle",
  "space_sharing", "space_moderation", "members", "roles", "tenant_settings", "webhooks", "analytics",
  "audit", "read", "write", "none",
];

async function permLabels(page: import("@playwright/test").Page, lang: string): Promise<string[]> {
  await page.addInitScript((l) => { try { localStorage.setItem("wks.lang", l); } catch { /* private */ } }, lang);
  await openDemo(page);
  await page.goto("/admin/api");
  const toggle = page.getByTestId("api-key-narrow-toggle");
  await expect(toggle, "the create form is on screen").toBeVisible({ timeout: 20_000 });
  await toggle.click();
  await expect(page.getByTestId("api-key-perm-list")).toBeVisible({ timeout: 10_000 });
  await sleep(300);
  // Every word the row offers — the type's name AND the three action labels beside it, because the
  // fallback that shipped #662 painted a raw key wherever one was missing, and either half can be.
  return (await page.getByTestId("api-key-perm-row").allInnerTexts())
    .flatMap((row) => row.split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

test("#662: a Japanese admin is offered the permission vocabulary in Japanese", async ({ page }) => {
  test.setTimeout(120_000);
  const ja = await permLabels(page, "ja");
  expect(ja.length, "the table is populated").toBeGreaterThan(20);

  const raw = ja.filter((l) => WIRE_WORDS.includes(l.toLowerCase()));
  expect(raw, `raw wire words reached a Japanese screen :: ${JSON.stringify(raw)}`).toEqual([]);

  // …and it really is Japanese rather than merely "not the wire word": a stray romanisation or an
  // English fallback would clear the check above and still be the defect #662 was about.
  expect(ja.some((l) => /[ぁ-んァ-ン一-龯]/.test(l)), `nothing on this screen is Japanese :: ${JSON.stringify(ja.slice(0, 8))}`).toBe(true);
});

test("#662: English is a translation too, not the wire words left showing", async ({ page }) => {
  test.setTimeout(120_000);
  const en = await permLabels(page, "en");
  expect(en.length, "the table is populated").toBeGreaterThan(20);
  // The English reader is the one an untranslated screen hides from: `pages` and `tenant_settings` look
  // enough like English to pass unnoticed, which is why the identifier form is forbidden here as well.
  const raw = en.filter((l) => WIRE_WORDS.includes(l.toLowerCase()) && /[_]/.test(l));
  expect(raw, `raw wire identifiers reached the English screen :: ${JSON.stringify(raw)}`).toEqual([]);
});
