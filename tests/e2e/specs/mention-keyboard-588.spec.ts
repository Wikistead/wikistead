import { test, expect } from "@playwright/test";
import { API, openDemo, sleep } from "../helpers";

// #588: the @mention list answers the keyboard.
//
// It had no key handling at all: you typed `@`, the list opened, and the only way to take a suggestion
// was the mouse. The convention is the app's own — Ctrl-j / Ctrl-k plus the arrows (Ctrl-n and Ctrl-p
// are browser-reserved, which is why the palette picked j/k), Enter confirms, Escape closes.
//
// SCOPE, stated because it is not obvious: this tenant seats exactly ONE page-viewer (dev-user), so
// there is no second row to move to and this file cannot show navigation. Seeding a second member
// means the whole invite-accept flow in another browser context — a heavy fixture for arithmetic. The
// arithmetic and the key policy are pinned in mention-nav.test.ts; what is pinned HERE is everything
// only a browser can answer: that the keys reach the textarea at all, that Enter takes the highlighted
// row and inserts it, that Escape closes, and that a CLOSED list leaves Enter to the composer.
const rows = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-testid=mention-option]")].map((el) => ({
      name: el.textContent?.trim() ?? "",
      active: el.getAttribute("data-active") === "true",
    })),
  );

async function composerWithSuggestions(page: import("@playwright/test").Page) {
  await openDemo(page);
  const stamp = Date.now().toString(36);
  const pageId = await page.evaluate(async ({ api, stamp }) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: `mention keyboard ${stamp}` }),
    });
    return ((await r.json()) as { id: string }).id;
  }, { api: API, stamp });
  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  // #212: the toggle lives in the ⋯ overflow, and the dropdown's dismissable layer eats the next
  // Escape unless it has finished closing — comments.spec.ts learned both the hard way.
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=comments-toggle]");
  await page.locator("[data-testid=page-overflow]").waitFor({ state: "detached" }).catch(() => {});
  const input = page.locator("[data-testid=comment-input]").last();
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.click();
  await page.keyboard.type("hello @");
  await expect(page.getByTestId("mention-suggest")).toBeVisible({ timeout: 8000 });
  return input;
}

test("#588: the keys reach the list, and Enter inserts the highlighted row", async ({ page }) => {
  const input = await composerWithSuggestions(page);
  const opened = await rows(page);
  expect(opened.length).toBeGreaterThan(0);
  expect(opened[0]!.active, "the first row starts highlighted").toBe(true);

  // Ctrl-j must be HANDLED, not typed: the list stays open, the highlight stays valid, and no stray
  // character lands in the textarea. (With one row it wraps onto itself — see the file header.)
  const before = await input.inputValue();
  await page.keyboard.press("Control+j");
  await sleep(150);
  expect(await input.inputValue(), "the key did not leak into the text").toBe(before);
  const after = await rows(page);
  expect(after.filter((r) => r.active).length, "exactly one row is highlighted").toBe(1);

  const chosen = after.find((r) => r.active)!.name;
  await page.keyboard.press("Enter");
  await sleep(200);
  await expect(page.getByTestId("mention-suggest"), "confirming closes the list").toHaveCount(0);
  expect(await input.inputValue(), `the highlighted name was inserted (${chosen})`).toContain(`@${chosen.replace(/\s/g, "")}`);
});

test("#588: Escape closes the list, and Enter then belongs to the composer again", async ({ page }) => {
  const input = await composerWithSuggestions(page);
  await page.keyboard.press("Escape");
  await sleep(150);
  await expect(page.getByTestId("mention-suggest")).toHaveCount(0);

  // the non-regression that matters: with no list open, the composer submits as it always did
  await input.fill("plain comment without a mention");
  await page.locator("[data-testid=comment-submit]").last().click();
  await expect(page.getByText("plain comment without a mention")).toBeVisible({ timeout: 8000 });
});

test("#588: the pointer moves the highlight too (#412)", async ({ page }) => {
  await composerWithSuggestions(page);
  await page.getByTestId("mention-option").first().hover();
  await sleep(150);
  const after = await rows(page);
  expect(after[0]!.active, "hovering moves the highlight to the row under the pointer").toBe(true);
});
