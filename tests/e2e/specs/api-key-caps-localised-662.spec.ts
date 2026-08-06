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
const WIRE_VERBS = ["view", "edit", "publish", "delete", "comment", "manage"];

async function capLabels(page: import("@playwright/test").Page, lang: string): Promise<string[]> {
  await page.addInitScript((l) => { try { localStorage.setItem("wks.lang", l); } catch { /* private */ } }, lang);
  await openDemo(page);
  await page.goto("/admin/api");
  const toggle = page.getByTestId("api-key-narrow-toggle");
  await expect(toggle, "the create form is on screen").toBeVisible({ timeout: 20_000 });
  await toggle.click();
  await expect(page.getByTestId("api-key-cap-list")).toBeVisible({ timeout: 10_000 });
  await sleep(300);
  return (await page.getByTestId("api-key-cap-option").allInnerTexts()).map((s) => s.trim()).filter(Boolean);
}

test("#662: a Japanese admin is offered capabilities in Japanese", async ({ page }) => {
  test.setTimeout(120_000);
  const ja = await capLabels(page, "ja");
  expect(ja.length, "the six narrowable capabilities are offered").toBe(WIRE_VERBS.length);

  const raw = ja.filter((l) => WIRE_VERBS.includes(l.toLowerCase()));
  expect(raw, `raw wire verbs reached a Japanese screen :: ${JSON.stringify(ja)}`).toEqual([]);

  // …and it is really the shared vocabulary, not a second one invented for this form. `adminRoles.cap`
  // is what the role editor uses, so the same capability reads the same word on both screens.
  expect(ja, "the capability vocabulary the role editor uses").toContain("閲覧");
  expect(ja, "…all of it").toContain("編集");
});

test("#662: English is unchanged, so the fix is a translation and not a rename", async ({ page }) => {
  test.setTimeout(120_000);
  const en = await capLabels(page, "en");
  expect(en.length).toBe(WIRE_VERBS.length);
  // English capitalises them (`adminRoles.cap.view` = "View"), which is the role editor's wording too.
  // Comparing case-insensitively keeps this about WHICH WORDS, not about their shape.
  expect(en.map((s) => s.toLowerCase()).sort(), "the same six, in English").toEqual([...WIRE_VERBS].sort());
});
